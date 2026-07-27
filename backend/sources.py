"""Upstream source adapters.

Everything source-specific lives here: the Panthers RSS feed and ESPN's public
team endpoints, which between them cover news, schedule and roster. To add
another source, add a `fetch_*` function plus its own adapter; nothing outside
this module needs to know how an upstream payload is shaped. Raw feedparser
entries and raw ESPN JSON never leave this file.
"""

import hashlib
import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from time import mktime
from typing import Any, Dict, List, Optional

import feedparser

from models import Article, Game, Injury, Player, Standings, TeamStanding

logger = logging.getLogger(__name__)

PANTHERS_SOURCE = "panthers.com"
_HTTP_TIMEOUT_SECONDS = 10


def _stable_id(url: str) -> str:
    normalized = (url or "").strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _parse_published(entry) -> Optional[datetime]:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if not parsed:
        return None
    return datetime.fromtimestamp(mktime(parsed), tz=timezone.utc)


def _extract_image(entry) -> Optional[str]:
    # feedparser normalizes media across several RSS conventions.
    media = entry.get("media_content") or []
    for item in media:
        if item.get("url"):
            return item["url"]

    thumbnails = entry.get("media_thumbnail") or []
    for thumb in thumbnails:
        if thumb.get("url"):
            return thumb["url"]

    for enc in entry.get("enclosures") or []:
        if str(enc.get("type", "")).startswith("image") and enc.get("href"):
            return enc["href"]

    return None


def _entry_to_article(entry) -> Article:
    """Adapter: map one feedparser entry onto the normalized Article model."""
    url = entry.get("link", "")
    return Article(
        id=_stable_id(url),
        title=(entry.get("title") or "").strip(),
        summary=(entry.get("summary") or "").strip(),
        url=url,
        published_at=_parse_published(entry),
        image_url=_extract_image(entry),
        source=PANTHERS_SOURCE,
    )


def fetch_panthers_articles(feed_url: str) -> List[Article]:
    """Fetch and parse the Panthers RSS feed into normalized Articles."""
    parsed = feedparser.parse(feed_url)

    if parsed.bozo and not parsed.entries:
        raise RuntimeError(
            f"Failed to parse feed {feed_url}: {parsed.get('bozo_exception')}"
        )

    articles = [_entry_to_article(entry) for entry in parsed.entries]
    logger.info("Fetched %d articles from %s", len(articles), feed_url)
    return articles


# --- Article body text -------------------------------------------------------
_BODY_CLASS = "nfl-c-article__body"
# Subtrees inside the body that aren't article prose.
_SKIP_TAGS = {"script", "style", "noscript", "figure", "aside"}
_SKIP_CLASSES = (
    "related-links",
    "custom-promo",
    "share-bar",
    "body-part--photo",
    "body-part--video",
    "gallery",
)
_TEXT_TAGS = {"p", "h2", "h3", "li", "blockquote"}
_VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}
_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
_MAX_PAGE_BYTES = 5 * 1024 * 1024


class _ArticleBodyParser(HTMLParser):
    """Collect prose from within the article body container.

    Walks the document, starts capturing once it enters the element carrying
    `root_class`, and emits the text of each block-level element it finds —
    skipping promo, gallery and related-links subtrees along the way. Emits
    plain text, never markup.

    `root_class=None` means the input is already just the body, with no
    wrapper to find, so capture starts immediately.
    """

    def __init__(self, root_class: Optional[str] = _BODY_CLASS) -> None:
        super().__init__(convert_charrefs=True)
        self.paragraphs: List[str] = []
        self._root_class = root_class
        # Nesting depth within the body; 0 means "not there yet".
        self._depth = 0 if root_class else 1
        self._skip_depth = 0
        self._capture: Optional[List[str]] = None

    def handle_starttag(self, tag, attrs):
        void = tag in _VOID_TAGS

        if self._skip_depth:
            if not void:
                self._skip_depth += 1
            return

        if self._depth:
            classes = dict(attrs).get("class", "")
            if tag in _SKIP_TAGS or any(c in classes for c in _SKIP_CLASSES):
                if not void:
                    self._skip_depth = 1
                return
            if tag in _TEXT_TAGS and self._capture is None:
                self._capture = []
            if not void:
                self._depth += 1
            return

        if self._root_class and self._root_class in dict(attrs).get("class", ""):
            self._depth = 1

    def handle_endtag(self, tag):
        if self._skip_depth:
            self._skip_depth -= 1
            return
        if not self._depth:
            return
        if tag in _TEXT_TAGS and self._capture is not None:
            text = re.sub(r"\s+", " ", "".join(self._capture)).strip()
            if text:
                self.paragraphs.append(text)
            self._capture = None
        # Without a wrapper there is nothing to leave, so a stray close tag
        # must not end capture early.
        if self._depth > 1 or self._root_class:
            self._depth -= 1

    def handle_data(self, data):
        if self._capture is not None and not self._skip_depth:
            self._capture.append(data)


def fetch_article_text(url: str) -> List[str]:
    """Fetch an article page and extract its body copy as plain paragraphs."""
    request = urllib.request.Request(url, headers={"User-Agent": _BROWSER_UA})

    try:
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT_SECONDS) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            html = response.read(_MAX_PAGE_BYTES).decode(charset, errors="replace")
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise RuntimeError(f"Failed to fetch article {url}: {exc}") from exc

    parser = _ArticleBodyParser()
    parser.feed(html)

    if not parser.paragraphs:
        raise RuntimeError(f"No article body found at {url}")

    logger.info("Extracted %d paragraphs from %s", len(parser.paragraphs), url)
    return parser.paragraphs


# --- ESPN plumbing (shared by news, schedule and roster) ---------------------
def _fetch_espn_json(url: str) -> Dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=_HTTP_TIMEOUT_SECONDS) as response:
            return json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Failed to fetch {url}: {exc}") from exc


def _parse_espn_datetime(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        # ESPN emits e.g. "2026-09-13T17:00Z", which fromisoformat rejects.
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


# --- News (ESPN public team endpoint) ----------------------------------------
ESPN_SOURCE = "espn.com"
ESPN_NEWS_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/news"
_ESPN_TEAM_ID = 29  # Carolina, in ESPN's team numbering.
ESPN_NEWS_LIMIT = 50


def _espn_image(item: Dict[str, Any]) -> Optional[str]:
    """Prefer the 16:9 header shot; fall back to whatever image is present."""
    images = item.get("images") or []
    for image in images:
        if image.get("type") == "header" and image.get("url"):
            return image["url"]
    return next((i["url"] for i in images if i.get("url")), None)


def _espn_item_to_article(item: Dict[str, Any]) -> Optional[Article]:
    """Adapter: map one ESPN news item onto the normalized Article model.

    Returns None for items we can't link to, rather than failing the whole
    feed over a single malformed entry.
    """
    url = ((item.get("links") or {}).get("web") or {}).get("href")
    headline = item.get("headline")
    if not url or not headline:
        return None

    # ESPN bot-blocks its article pages, but the same story is served as JSON
    # from the content API that each item points at.
    content_url = (
        (((item.get("links") or {}).get("api") or {}).get("self") or {}).get("href")
    )

    return Article(
        id=_stable_id(url),
        title=headline.strip(),
        summary=(item.get("description") or "").strip(),
        url=url,
        published_at=_parse_espn_datetime(item.get("published")),
        image_url=_espn_image(item),
        source=ESPN_SOURCE,
        content_url=content_url,
    )


def fetch_espn_articles(limit: int = ESPN_NEWS_LIMIT) -> List[Article]:
    """Fetch ESPN's Panthers news feed as normalized Articles.

    ESPN tags league-wide pieces with every team, so `team=` scopes the feed
    but doesn't guarantee every item is Panthers-only — the same set ESPN
    shows on its own team page.
    """
    query = urllib.parse.urlencode({"team": _ESPN_TEAM_ID, "limit": limit})
    payload = _fetch_espn_json(f"{ESPN_NEWS_URL}?{query}")

    items = payload.get("articles") or []
    articles = [a for a in (_espn_item_to_article(i) for i in items) if a is not None]
    logger.info("Fetched %d articles from %s", len(articles), ESPN_SOURCE)
    return articles


def fetch_espn_article_text(content_url: str) -> List[str]:
    """Extract an ESPN story's body copy from the content API.

    The story arrives as an HTML fragment of block elements with no wrapper,
    so the parser captures from the first tag.
    """
    payload = _fetch_espn_json(content_url)

    headlines = payload.get("headlines") or []
    story = headlines[0].get("story") if headlines else None
    if not story:
        raise RuntimeError(f"No story body in ESPN response for {content_url}")

    parser = _ArticleBodyParser(root_class=None)
    parser.feed(story)

    if not parser.paragraphs:
        raise RuntimeError(f"No article body found at {content_url}")

    logger.info(
        "Extracted %d paragraphs from %s", len(parser.paragraphs), content_url
    )
    return parser.paragraphs


def fetch_article_body(article: Article) -> List[str]:
    """Body text for one article, however its source happens to serve it."""
    if article.source == ESPN_SOURCE and article.content_url:
        return fetch_espn_article_text(article.content_url)
    return fetch_article_text(article.url)


# --- Schedule (ESPN public team endpoint) ------------------------------------
ESPN_SCHEDULE_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/car/schedule"
)
REGULAR_SEASON_WEEKS = 18
_ESPN_REGULAR_SEASON = 2  # ESPN's seasontype for the regular season.
_TEAM_ABBR = "CAR"


def current_season() -> int:
    """The NFL season currently in play.

    A season spans September through early February, so January and February
    still belong to the previous year's season.
    """
    now = datetime.now(timezone.utc)
    return now.year - 1 if now.month <= 2 else now.year


def _score(competitor: Dict[str, Any]) -> Optional[int]:
    score = competitor.get("score")
    if isinstance(score, dict):
        score = score.get("value")
    try:
        return int(float(score))
    except (TypeError, ValueError):
        return None


def _logo(team: Dict[str, Any]) -> Optional[str]:
    for logo in team.get("logos") or []:
        if logo.get("href"):
            return logo["href"]
    return None


def _network(competition: Dict[str, Any]) -> Optional[str]:
    for broadcast in competition.get("broadcasts") or []:
        name = (broadcast.get("media") or {}).get("shortName")
        if name:
            return name
    return None


def _event_to_game(event: Dict[str, Any]) -> Optional[Game]:
    """Adapter: map one ESPN event onto the normalized Game model.

    Returns None for events we can't make sense of rather than failing the
    whole schedule over a single malformed entry.
    """
    week = (event.get("week") or {}).get("number")
    competitions = event.get("competitions") or []
    if not week or not competitions:
        return None

    competition = competitions[0]
    competitors = competition.get("competitors") or []

    us = next(
        (
            c
            for c in competitors
            if (c.get("team") or {}).get("abbreviation") == _TEAM_ABBR
        ),
        None,
    )
    them = next((c for c in competitors if c is not us), None)
    if us is None or them is None:
        return None

    state = ((competition.get("status") or {}).get("type") or {}).get("state")
    status = {"pre": "scheduled", "in": "in_progress", "post": "final"}.get(
        state, "scheduled"
    )

    team_score = _score(us)
    opponent_score = _score(them)

    outcome = None
    if status == "final" and team_score is not None and opponent_score is not None:
        if team_score > opponent_score:
            outcome = "W"
        elif team_score < opponent_score:
            outcome = "L"
        else:
            outcome = "T"

    opponent_team = them.get("team") or {}

    return Game(
        week=int(week),
        kickoff=_parse_espn_datetime(competition.get("date") or event.get("date")),
        opponent=opponent_team.get("displayName"),
        opponent_abbr=opponent_team.get("abbreviation"),
        opponent_logo=_logo(opponent_team),
        home=us.get("homeAway") == "home",
        venue=(competition.get("venue") or {}).get("fullName"),
        network=_network(competition),
        status=status,
        team_score=team_score,
        opponent_score=opponent_score,
        outcome=outcome,
        url=next(
            (
                link.get("href")
                for link in event.get("links") or []
                if str(link.get("href", "")).startswith("http")
            ),
            None,
        ),
    )


def _with_bye_weeks(games: List[Game]) -> List[Game]:
    """Fill the gaps in the week numbering with bye entries.

    ESPN simply omits the bye, so any missing week between the first and last
    scheduled game is one.
    """
    if not games:
        return games

    played = {g.week for g in games}
    last_week = max(max(played), REGULAR_SEASON_WEEKS)
    byes = [
        Game(week=w, bye=True) for w in range(1, last_week + 1) if w not in played
    ]
    return sorted(games + byes, key=lambda g: g.week)


def fetch_panthers_schedule(season: int) -> List[Game]:
    """Fetch the Panthers regular-season schedule from ESPN's public API."""
    query = urllib.parse.urlencode(
        {"season": season, "seasontype": _ESPN_REGULAR_SEASON}
    )
    payload = _fetch_espn_json(f"{ESPN_SCHEDULE_URL}?{query}")

    events = payload.get("events") or []
    games = [g for g in (_event_to_game(e) for e in events) if g is not None]
    if not games:
        raise RuntimeError(f"No games found in ESPN response for season {season}")

    schedule = _with_bye_weeks(games)
    logger.info("Fetched %d games for the %d season", len(games), season)
    return schedule


# --- Standings (ESPN public league endpoint) ---------------------------------
ESPN_STANDINGS_URL = "https://site.api.espn.com/apis/v2/sports/football/nfl/standings"
# level=3 nests conference -> division -> entries; anything shallower loses the
# division split we need.
_STANDINGS_LEVEL = 3
_DIVISION_NAME = "NFC South"


def _standing_stats(entry: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Index one entry's flat stats list by name."""
    return {s["name"]: s for s in entry.get("stats") or [] if s.get("name")}


def _stat_int(stats: Dict[str, Dict[str, Any]], name: str) -> Optional[int]:
    try:
        return int(float(stats[name]["value"]))
    except (KeyError, TypeError, ValueError):
        return None


def _stat_text(stats: Dict[str, Dict[str, Any]], name: str) -> Optional[str]:
    value = (stats.get(name) or {}).get("displayValue")
    return value or None


def _entry_to_standing(entry: Dict[str, Any]) -> Optional[TeamStanding]:
    """Adapter: map one standings entry onto the normalized TeamStanding.

    Returns None for entries we can't make sense of rather than failing the
    whole table over a single malformed one.
    """
    team = entry.get("team") or {}
    abbreviation = team.get("abbreviation")
    if not abbreviation:
        return None

    stats = _standing_stats(entry)
    wins = _stat_int(stats, "wins") or 0
    losses = _stat_int(stats, "losses") or 0
    ties = _stat_int(stats, "ties") or 0

    return TeamStanding(
        team_id=str(team.get("id") or abbreviation),
        name=team.get("displayName") or abbreviation,
        abbreviation=abbreviation,
        logo=_logo(team),
        wins=wins,
        losses=losses,
        ties=ties,
        # Ties are rare enough that showing "8-9-0" every week would be noise.
        record=f"{wins}-{losses}-{ties}" if ties else f"{wins}-{losses}",
        win_pct=_stat_text(stats, "winPercent"),
        streak=_stat_text(stats, "streak"),
        points_for=_stat_int(stats, "pointsFor"),
        points_against=_stat_int(stats, "pointsAgainst"),
        division_record=_stat_text(stats, "divisionRecord"),
        playoff_seed=_stat_int(stats, "playoffSeed"),
        clinched=_stat_text(stats, "clincher"),
        panthers=abbreviation.upper() == _TEAM_ABBR,
    )


def fetch_standings(season: int) -> Standings:
    """Fetch the NFC South table plus every team's record, in one request.

    ESPN returns division entries already ordered by its own tiebreakers, so
    the order here is preserved rather than recomputed.
    """
    query = urllib.parse.urlencode({"season": season, "level": _STANDINGS_LEVEL})
    payload = _fetch_espn_json(f"{ESPN_STANDINGS_URL}?{query}")

    division: List[TeamStanding] = []
    league: Dict[str, TeamStanding] = {}

    for conference in payload.get("children") or []:
        for group in conference.get("children") or []:
            entries = (group.get("standings") or {}).get("entries") or []
            standings = [s for s in (_entry_to_standing(e) for e in entries) if s]
            for standing in standings:
                league[standing.abbreviation.upper()] = standing
            if group.get("name") == _DIVISION_NAME:
                division = standings

    if not division:
        raise RuntimeError(f"No {_DIVISION_NAME} standings for season {season}")

    logger.info("Fetched standings for %d teams in the %d season", len(league), season)
    return Standings(season=season, division=division, league=league)


def standings_are_empty(standings: Standings) -> bool:
    """True when no games have been played yet, i.e. every team sits at 0-0.

    ESPN publishes the coming season's table months early, filled with zeros;
    callers use this to fall back to the last completed season.
    """
    return all(
        team.wins == 0 and team.losses == 0 and team.ties == 0
        for team in standings.division
    )


# --- Roster (ESPN public team endpoint) --------------------------------------
ESPN_ROSTER_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/car/roster"
)

# ESPN's group keys, in the order we want them displayed.
_ROSTER_GROUPS = {
    "offense": "Offense",
    "defense": "Defense",
    "specialTeam": "Special Teams",
    "injuredReserveOrOut": "Injured Reserve",
    "suspended": "Suspended",
    "practiceSquad": "Practice Squad",
}


def _athlete_to_player(athlete: Dict[str, Any], group: str) -> Optional[Player]:
    """Adapter: map one ESPN athlete onto the normalized Player model."""
    athlete_id = athlete.get("id")
    name = athlete.get("displayName") or athlete.get("fullName")
    if not athlete_id or not name:
        return None

    position = athlete.get("position") or {}
    weight = athlete.get("weight")

    return Player(
        id=str(athlete_id),
        name=name,
        jersey=athlete.get("jersey"),
        position=position.get("abbreviation"),
        position_name=position.get("displayName"),
        group=group,
        height=athlete.get("displayHeight"),
        weight=int(weight) if isinstance(weight, (int, float)) else None,
        age=athlete.get("age"),
        experience=(athlete.get("experience") or {}).get("years"),
        college=(athlete.get("college") or {}).get("name"),
        headshot=(athlete.get("headshot") or {}).get("href"),
    )


# Skill positions lead; everything else follows alphabetically.
_POSITION_ORDER = ("QB", "RB", "WR", "TE")


def _roster_sort_key(player: Player):
    """Cluster each group by position, then order by jersey number."""
    position = player.position or "ZZ"
    rank = (
        _POSITION_ORDER.index(position)
        if position in _POSITION_ORDER
        else len(_POSITION_ORDER)
    )
    try:
        jersey = int(player.jersey) if player.jersey else 999
    except ValueError:
        jersey = 999
    return (rank, position, jersey)


ESPN_DEPTH_CHART_URL = (
    "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
    "/seasons/{season}/teams/29/depthcharts"
)
_ATHLETE_ID_PATTERN = re.compile(r"/athletes/(\d+)")


def fetch_depth_chart_starters(season: int) -> Dict[str, str]:
    """Map athlete id -> the depth-chart slot they start at.

    Only rank 1 at each slot counts as a starter. Athlete ids come from the
    reference URLs, so this needs one request rather than one per player.
    """
    payload = _fetch_espn_json(ESPN_DEPTH_CHART_URL.format(season=season))

    starters: Dict[str, str] = {}
    for chart in payload.get("items") or []:
        for slot in (chart.get("positions") or {}).values():
            abbreviation = (slot.get("position") or {}).get("abbreviation")
            for entry in slot.get("athletes") or []:
                if entry.get("rank") != 1:
                    continue
                ref = (entry.get("athlete") or {}).get("$ref", "")
                match = _ATHLETE_ID_PATTERN.search(ref)
                if match and abbreviation:
                    starters.setdefault(match.group(1), abbreviation)

    return starters


def fetch_panthers_roster(season: int) -> List[Player]:
    """Fetch the current Panthers roster, flagged with depth-chart starters."""
    payload = _fetch_espn_json(ESPN_ROSTER_URL)

    players: List[Player] = []
    for entry in payload.get("athletes") or []:
        label = _ROSTER_GROUPS.get(entry.get("position", ""))
        if label is None:
            continue
        group = [
            p
            for p in (
                _athlete_to_player(a, label) for a in entry.get("items") or []
            )
            if p is not None
        ]
        players.extend(sorted(group, key=_roster_sort_key))

    if not players:
        raise RuntimeError("No players found in ESPN roster response")

    # The roster is the point of this call; a missing depth chart shouldn't
    # sink it, so degrade to "no starters known" instead of failing.
    try:
        starters = fetch_depth_chart_starters(season)
    except RuntimeError:
        logger.exception("Depth chart unavailable; roster will have no starters")
        starters = {}

    for player in players:
        slot = starters.get(player.id)
        if slot:
            player.starter = True
            player.depth_position = slot

    logger.info(
        "Fetched %d players (%d starters)",
        len(players),
        sum(1 for p in players if p.starter),
    )
    return players


# --- Injury report (ESPN public injuries endpoint) ---------------------------
ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"

# Worst first. This is the order the report reads in; anything ESPN sends that
# isn't listed here sorts to the bottom rather than being dropped.
_INJURY_STATUS_ORDER = (
    "Injured Reserve",
    "Out",
    "Doubtful",
    "Questionable",
    "Day-To-Day",
)

# ESPN's placeholders for "we don't know yet". Rendering them verbatim puts
# "Not Specified" on screen next to a player's name, which reads like a bug.
_UNSPECIFIED = {"not specified", "unknown", "none", ""}


def _injury_text(value: Any) -> Optional[str]:
    """Trim one of ESPN's detail strings, dropping its placeholders."""
    text = str(value or "").strip()
    return None if text.lower() in _UNSPECIFIED else text


def _athlete_link(athlete: Dict[str, Any]) -> Optional[str]:
    """The player-card URL, when ESPN includes one."""
    for link in athlete.get("links") or []:
        if "playercard" in (link.get("rel") or []):
            href = link.get("href")
            if isinstance(href, str) and href.startswith("http"):
                return href
    return None


def _entry_to_injury(entry: Dict[str, Any]) -> Optional[Injury]:
    """Adapter: map one ESPN injury entry onto the normalized Injury model."""
    athlete = entry.get("athlete") or {}
    name = athlete.get("displayName") or athlete.get("fullName")
    status = _injury_text(entry.get("status"))
    if not name or not status:
        return None

    details = entry.get("details") or {}

    return Injury(
        # Falls back to the name so an entry without an id still renders with a
        # stable React key instead of colliding with every other id-less row.
        id=str(entry.get("id") or name),
        name=name,
        position=(athlete.get("position") or {}).get("abbreviation"),
        headshot=(athlete.get("headshot") or {}).get("href"),
        status=status,
        # ESPN splits the injury across two fields: `type` is the body part
        # ("Knee") and `detail` is what happened to it ("Soreness").
        body_part=_injury_text(details.get("type")),
        detail=_injury_text(details.get("detail")),
        return_date=_parse_espn_datetime(details.get("returnDate")),
        comment=_injury_text(entry.get("shortComment")),
        updated_at=_parse_espn_datetime(entry.get("date")),
        url=_athlete_link(athlete),
    )


def _injury_sort_key(injury: Injury):
    status = injury.status
    rank = (
        _INJURY_STATUS_ORDER.index(status)
        if status in _INJURY_STATUS_ORDER
        else len(_INJURY_STATUS_ORDER)
    )
    return (rank, injury.name)


def fetch_injuries() -> List[Injury]:
    """Carolina's injury report, worst status first.

    ESPN publishes all 32 teams in one document, so this costs one request
    rather than one per player. "Active" entries are filtered out: those are
    transaction notes (a contract, a return to practice) rather than injuries,
    and in the offseason they outnumber the report itself.
    """
    payload = _fetch_espn_json(ESPN_INJURIES_URL)

    for team in payload.get("injuries") or []:
        if str(team.get("id")) != str(_ESPN_TEAM_ID):
            continue

        injuries = [
            injury
            for injury in (
                _entry_to_injury(e) for e in team.get("injuries") or []
            )
            if injury is not None and injury.status != "Active"
        ]
        injuries.sort(key=_injury_sort_key)
        logger.info("Fetched %d injuries", len(injuries))
        return injuries

    # An empty report is a real answer — in June nobody is listed. Carolina
    # missing from the document altogether is not, and should not be cached as
    # "everyone is healthy".
    raise RuntimeError("Carolina not found in ESPN injuries response")
