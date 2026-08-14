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

from models import (
    Article,
    Drive,
    Game,
    GameLeader,
    GameLine,
    Injury,
    LiveGame,
    LiveSituation,
    LiveTeam,
    Player,
    ScoringPlay,
    SeasonFutures,
    Standings,
    StatPair,
    TeamStanding,
    WinProbPoint,
)

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
        # Carried so the odds lookup can address this game directly; ESPN keys
        # its betting endpoints on the event, not the week.
        event_id=str(event["id"]) if event.get("id") else None,
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


def _clean_text(value: Any) -> Optional[str]:
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


# ".../nfl/player/_/id/4241416/chuba-hubbard" -> "4241416".
_ATHLETE_ID_IN_URL = re.compile(r"/id/(\d+)")


def _athlete_id(athlete: Dict[str, Any]) -> Optional[str]:
    """The athlete's ESPN id, dug out of the links they appear in.

    Unlike the roster feed, the injuries document carries no `id` on the athlete
    itself — the only place the number appears is inside the href of the links
    ESPN attaches (player card, stats, news), which all key on it.
    """
    for link in athlete.get("links") or []:
        href = link.get("href")
        if not isinstance(href, str):
            continue
        match = _ATHLETE_ID_IN_URL.search(href)
        if match:
            return match.group(1)
    return None


def _entry_to_injury(entry: Dict[str, Any]) -> Optional[Injury]:
    """Adapter: map one ESPN injury entry onto the normalized Injury model."""
    athlete = entry.get("athlete") or {}
    name = athlete.get("displayName") or athlete.get("fullName")
    status = _clean_text(entry.get("status"))
    if not name or not status:
        return None

    details = entry.get("details") or {}

    return Injury(
        # Falls back to the name so an entry without an id still renders with a
        # stable React key instead of colliding with every other id-less row.
        id=str(entry.get("id") or name),
        athlete_id=_athlete_id(athlete),
        name=name,
        position=(athlete.get("position") or {}).get("abbreviation"),
        headshot=(athlete.get("headshot") or {}).get("href"),
        status=status,
        # ESPN splits the injury across two fields: `type` is the body part
        # ("Knee") and `detail` is what happened to it ("Soreness").
        body_part=_clean_text(details.get("type")),
        detail=_clean_text(details.get("detail")),
        return_date=_parse_espn_datetime(details.get("returnDate")),
        comment=_clean_text(entry.get("shortComment")),
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


# --- Odds (ESPN's betting endpoints, which relay the sportsbooks) ------------
ESPN_ODDS_URL = (
    "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
    "/events/{event}/competitions/{event}/odds"
)
ESPN_FUTURES_URL = (
    "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
    "/seasons/{season}/futures?limit=100"
)

# ESPN's futures market ids, mapped onto the fields we keep. Matching on id
# rather than name: the names are inconsistent ("Pro Football (N) South
# Division" against "NFL - Super Bowl Winner") and read like internal labels.
_FUTURES_MARKETS = {
    3908: "division",  # NFC South
    3904: "conference",  # NFC
    1561: "super_bowl",
}

_TEAM_REF_PATTERN = re.compile(r"/teams/(\d+)")


def _signed_spread(spread: Optional[float], favorite: bool) -> Optional[str]:
    """Carolina's side of the spread, as a book would print it.

    ESPN reports the spread unsigned and marks the favourite separately, so the
    sign has to be put back on before this means anything to a reader.
    """
    if spread is None:
        return None
    points = abs(float(spread))
    # "-3" rather than "-3.0"; half-points keep their decimal.
    text = f"{points:g}"
    return f"-{text}" if favorite else f"+{text}"


def _money_line(side: Dict[str, Any]) -> Optional[int]:
    value = side.get("moneyLine")
    return int(value) if isinstance(value, (int, float)) else None


def fetch_game_odds(event_id: str, week: int, panthers_home: bool) -> Optional[GameLine]:
    """The line on one game, from whichever book ESPN ranks first.

    Returns None when no book has posted it yet, which is the normal state for
    a game months out — that is an empty strip, not an error.
    """
    payload = _fetch_espn_json(ESPN_ODDS_URL.format(event=event_id))

    items = payload.get("items") or []
    if not items:
        return None
    odds = items[0]

    ours = odds.get("homeTeamOdds" if panthers_home else "awayTeamOdds") or {}
    theirs = odds.get("awayTeamOdds" if panthers_home else "homeTeamOdds") or {}
    favorite = bool(ours.get("favorite"))

    over_under = odds.get("overUnder")

    return GameLine(
        week=week,
        provider=(odds.get("provider") or {}).get("name") or "Sportsbook",
        details=_clean_text(odds.get("details")),
        over_under=float(over_under) if isinstance(over_under, (int, float)) else None,
        spread=_signed_spread(odds.get("spread"), favorite),
        money_line=_money_line(ours),
        opponent_money_line=_money_line(theirs),
        favorite=favorite,
    )


def fetch_futures(season: int) -> Optional[SeasonFutures]:
    """Carolina's division, conference and Super Bowl prices.

    One request covers every market; each is scanned for the Panthers' row and
    skipped when they aren't quoted in it.
    """
    payload = _fetch_espn_json(ESPN_FUTURES_URL.format(season=season))

    provider: Optional[str] = None
    prices: Dict[str, str] = {}

    for market in payload.get("items") or []:
        field = _FUTURES_MARKETS.get(market.get("id"))
        if field is None:
            continue

        for book in market.get("futures") or []:
            for entry in book.get("books") or []:
                ref = (entry.get("team") or {}).get("$ref", "")
                match = _TEAM_REF_PATTERN.search(ref)
                if not match or match.group(1) != str(_ESPN_TEAM_ID):
                    continue
                value = _clean_text(entry.get("value"))
                if value:
                    prices.setdefault(field, value)
                    provider = provider or (book.get("provider") or {}).get("name")

    if not prices:
        return None

    logger.info("Fetched %d futures market(s)", len(prices))
    return SeasonFutures(provider=provider or "Sportsbook", **prices)


# --- Live game (ESPN's summary endpoint) -------------------------------------
# One request carries the whole game: score, clock, box score, drives, scoring
# plays, win probability and leaders. Everything below adapts that single
# payload — the alternative was a request per section, on a route meant to be
# polled every few seconds while a game is on.
ESPN_SUMMARY_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={event}"
)
# No `seasontype`: ESPN then answers with whichever one is current, so this
# tracks preseason in August and the playoffs in January without being told.
ESPN_CURRENT_SCHEDULE_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/car/schedule"
)

_QUARTER_SECONDS = 15 * 60
# ESPN's own labels are internal-sounding ("Pro Football (N) South Division"),
# but the season type names are clean enough to show.
_SEASON_TYPE_LABELS = {1: "Preseason", 2: "Regular Season", 3: "Postseason"}


def _clock_remaining(clock: Any) -> Optional[int]:
    """Seconds left in the period, from ESPN's "6:44" display value."""
    if isinstance(clock, dict):
        if isinstance(clock.get("value"), (int, float)):
            return int(clock["value"])
        clock = clock.get("displayValue")

    parts = str(clock or "").split(":")
    if len(parts) != 2:
        return None
    try:
        return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        return None


def _elapsed_seconds(period: Optional[int], clock: Any) -> Optional[int]:
    """Game clock burned so far, for putting a play on a time axis.

    Overtime is measured in quarter-length blocks like everything before it.
    That overstates a 10-minute period, but the axis only has to keep plays in
    order and spaced by how long they took, which it does.
    """
    remaining = _clock_remaining(clock)
    if not period or remaining is None:
        return None
    return (period - 1) * _QUARTER_SECONDS + (_QUARTER_SECONDS - remaining)


def _select_event() -> Optional[Dict[str, Any]]:
    """The one game the Live tab should be showing.

    In priority order: a game in progress, else the next one scheduled, else the
    one most recently finished. That last case is what carries the tab through
    the six days between games — a fan arriving on Tuesday wants Sunday's box
    score, not an empty page.
    """
    payload = _fetch_espn_json(ESPN_CURRENT_SCHEDULE_URL)
    events = payload.get("events") or []

    live: List[Dict[str, Any]] = []
    upcoming: List[Dict[str, Any]] = []
    finished: List[Dict[str, Any]] = []

    for event in events:
        competitions = event.get("competitions") or []
        if not event.get("id") or not competitions:
            continue
        state = ((competitions[0].get("status") or {}).get("type") or {}).get("state")
        {"in": live, "pre": upcoming}.get(state, finished).append(event)

    def kickoff(event: Dict[str, Any]) -> datetime:
        parsed = _parse_espn_datetime(event.get("date"))
        return parsed or datetime.max.replace(tzinfo=timezone.utc)

    if live:
        chosen = min(live, key=kickoff)
    elif upcoming:
        chosen = min(upcoming, key=kickoff)
    elif finished:
        chosen = max(finished, key=kickoff)
    else:
        return None

    season = payload.get("requestedSeason") or {}
    return {
        "event_id": str(chosen["id"]),
        "week": (chosen.get("week") or {}).get("number"),
        "season": season.get("year") or current_season(),
        "season_type": season.get("type") or _ESPN_REGULAR_SEASON,
        # The summary endpoint's header carries neither of these, but the
        # schedule event does, so they ride along rather than costing a request.
        "name": chosen.get("name"),
        "short_name": chosen.get("shortName"),
        "network": _network(chosen["competitions"][0]),
    }


def _competitor_to_live_team(competitor: Dict[str, Any]) -> Optional[LiveTeam]:
    """Adapter: map one header competitor onto the normalized LiveTeam."""
    team = competitor.get("team") or {}
    abbreviation = team.get("abbreviation")
    if not abbreviation:
        return None

    # ESPN omits `score` entirely before kickoff, and sends it as a string once
    # the game starts.
    try:
        score = int(competitor["score"])
    except (KeyError, TypeError, ValueError):
        score = None

    record = next(
        (
            r.get("summary")
            for r in competitor.get("record") or []
            if r.get("type") == "total" and r.get("summary")
        ),
        None,
    )

    linescores: List[Optional[int]] = []
    for line in competitor.get("linescores") or []:
        try:
            linescores.append(int(float(line.get("displayValue"))))
        except (TypeError, ValueError):
            linescores.append(None)

    return LiveTeam(
        id=str(team.get("id") or abbreviation),
        abbreviation=abbreviation,
        name=team.get("displayName") or abbreviation,
        short_name=team.get("shortDisplayName") or team.get("name") or abbreviation,
        logo=_logo(team),
        score=score,
        record=record,
        linescores=linescores,
        panthers=abbreviation.upper() == _TEAM_ABBR,
        home=competitor.get("homeAway") == "home",
    )


# The comparison rows, in the order they read. Each names how to get the number
# the bar is drawn from, because ESPN is inconsistent about where it lives: some
# stats carry a usable `value`, some send "-" there and put the number in
# `displayValue`, and some only have it inside a compound string like "6-55".
def _stat_from_value(entry: Dict[str, Any]) -> Optional[float]:
    value = entry.get("value")
    return float(value) if isinstance(value, (int, float)) else None


def _stat_from_display(entry: Dict[str, Any]) -> Optional[float]:
    try:
        return float(str(entry.get("displayValue", "")).strip())
    except ValueError:
        return None


def _stat_from_second_part(entry: Dict[str, Any]) -> Optional[float]:
    """The yards half of a "penalties-yards" pair like "6-55"."""
    parts = str(entry.get("displayValue", "")).split("-")
    try:
        return float(parts[1])
    except (IndexError, ValueError):
        return None


_COMPARISON_STATS = (
    ("totalYards", "Total yards", _stat_from_display),
    ("netPassingYards", "Passing yards", _stat_from_value),
    ("rushingYards", "Rushing yards", _stat_from_value),
    ("firstDowns", "First downs", _stat_from_value),
    ("thirdDownEff", "3rd down", _stat_from_value),
    ("totalPenaltiesYards", "Penalty yards", _stat_from_second_part),
    ("turnovers", "Turnovers", _stat_from_display),
    ("possessionTime", "Time of possession", _stat_from_value),
)


def _team_stats(boxscore: Dict[str, Any]) -> List[StatPair]:
    """The comparison table, one row per curated stat.

    Rows nobody has a number for are dropped, which is how this comes back empty
    before kickoff rather than as eight blank bars.
    """
    by_team: Dict[bool, Dict[str, Dict[str, Any]]] = {}
    for side in boxscore.get("teams") or []:
        panthers = (side.get("team") or {}).get("abbreviation", "").upper() == _TEAM_ABBR
        by_team[panthers] = {
            s["name"]: s for s in side.get("statistics") or [] if s.get("name")
        }

    ours = by_team.get(True, {})
    theirs = by_team.get(False, {})

    pairs: List[StatPair] = []
    for name, label, read_number in _COMPARISON_STATS:
        us = ours.get(name)
        them = theirs.get(name)
        if not us and not them:
            continue
        pairs.append(
            StatPair(
                key=name,
                label=label,
                panthers_display=(us or {}).get("displayValue"),
                opponent_display=(them or {}).get("displayValue"),
                panthers_value=read_number(us) if us else None,
                opponent_value=read_number(them) if them else None,
            )
        )

    return pairs


def _scoring_plays(payload: Dict[str, Any], panthers_home: bool) -> List[ScoringPlay]:
    """Every score, with the running total oriented to Carolina."""
    plays: List[ScoringPlay] = []

    for play in payload.get("scoringPlays") or []:
        text = (play.get("text") or "").strip()
        if not text:
            continue

        home_score = play.get("homeScore") or 0
        away_score = play.get("awayScore") or 0
        abbreviation = (play.get("team") or {}).get("abbreviation")

        plays.append(
            ScoringPlay(
                id=str(play.get("id") or f"{len(plays)}"),
                period=(play.get("period") or {}).get("number") or 0,
                clock=(play.get("clock") or {}).get("displayValue"),
                team_abbr=abbreviation,
                panthers=str(abbreviation).upper() == _TEAM_ABBR,
                text=text,
                type_abbr=(play.get("scoringType") or {}).get("abbreviation"),
                panthers_score=home_score if panthers_home else away_score,
                opponent_score=away_score if panthers_home else home_score,
            )
        )

    return plays


def _drive_yard(raw: Any, panthers_home: bool) -> Optional[int]:
    """ESPN's yard line, re-expressed as yards from Carolina's own goal line.

    ESPN measures from the *home* team's goal line, so the same number means
    opposite things depending on who is hosting. Normalizing here is what lets
    the drive chart put Carolina's end zone on the same side every week.
    """
    if not isinstance(raw, (int, float)):
        return None
    yard = int(raw)
    if not 0 <= yard <= 100:
        return None
    return yard if panthers_home else 100 - yard


def _drives(payload: Dict[str, Any], panthers_home: bool) -> List[Drive]:
    """Every drive so far, oldest first, with the one in progress last."""
    raw = payload.get("drives") or {}
    entries = list(raw.get("previous") or [])
    current = raw.get("current")
    if isinstance(current, dict):
        entries.append(current)

    drives: List[Drive] = []
    for index, entry in enumerate(entries):
        team = entry.get("team") or {}
        abbreviation = team.get("abbreviation")
        start = entry.get("start") or {}
        end = entry.get("end") or {}

        drives.append(
            Drive(
                id=str(entry.get("id") or index),
                team_abbr=abbreviation,
                panthers=str(abbreviation).upper() == _TEAM_ABBR,
                description=entry.get("description"),
                result=entry.get("displayResult") or entry.get("result"),
                period=(start.get("period") or {}).get("number"),
                plays=entry.get("offensivePlays"),
                yards=entry.get("yards"),
                is_score=bool(entry.get("isScore")),
                start_yard=_drive_yard(start.get("yardLine"), panthers_home),
                end_yard=_drive_yard(end.get("yardLine"), panthers_home),
                start_text=start.get("text"),
                end_text=end.get("text"),
                time_elapsed=(entry.get("timeElapsed") or {}).get("displayValue"),
            )
        )

    return drives


def _play_clock_index(payload: Dict[str, Any]) -> Dict[str, tuple]:
    """Map play id -> (period, elapsed seconds), for the win-probability axis."""
    raw = payload.get("drives") or {}
    entries = list(raw.get("previous") or [])
    current = raw.get("current")
    if isinstance(current, dict):
        entries.append(current)

    index: Dict[str, tuple] = {}
    for entry in entries:
        for play in entry.get("plays") or []:
            play_id = play.get("id")
            period = (play.get("period") or {}).get("number")
            elapsed = _elapsed_seconds(period, play.get("clock"))
            if play_id and elapsed is not None:
                index[str(play_id)] = (period, elapsed)

    return index


def _win_probability(
    payload: Dict[str, Any], panthers_home: bool
) -> List[WinProbPoint]:
    """Carolina's win probability over the course of the game.

    ESPN gives the *home* team's percentage keyed on a play id, and separately
    gives the plays, so the two are joined here to get a time axis. A play that
    doesn't resolve — the opening entry is keyed on a drive, not a play — keeps
    the previous point's timestamp rather than being dropped, which would put a
    gap in the line for no reason a reader could see.
    """
    points = payload.get("winprobability") or []
    if not points:
        return []

    clocks = _play_clock_index(payload)
    series: List[WinProbPoint] = []
    elapsed = 0
    period = 1

    for point in points:
        home_pct = point.get("homeWinPercentage")
        if not isinstance(home_pct, (int, float)):
            continue

        resolved = clocks.get(str(point.get("playId")))
        if resolved:
            # Clamp forward only: a line that steps backwards in time reads as a
            # rendering bug.
            period = resolved[0] or period
            elapsed = max(elapsed, resolved[1])

        tie_pct = point.get("tiePercentage") or 0
        panthers_pct = home_pct if panthers_home else 1 - home_pct - tie_pct

        series.append(
            WinProbPoint(
                elapsed=elapsed,
                period=period,
                panthers_pct=round(min(max(panthers_pct, 0.0), 1.0), 4),
            )
        )

    return series


# The three categories a fan looks for. ESPN also sends sacks and tackles, but
# six cards is already the most this earns on the page.
_LEADER_CATEGORIES = ("passingYards", "rushingYards", "receivingYards")


def _leaders(payload: Dict[str, Any]) -> List[GameLeader]:
    """Each side's passing, rushing and receiving leader.

    Comes back empty before kickoff: ESPN publishes the categories with no
    leaders in them until somebody has a stat.
    """
    leaders: List[GameLeader] = []

    for side in payload.get("leaders") or []:
        abbreviation = (side.get("team") or {}).get("abbreviation")
        panthers = str(abbreviation).upper() == _TEAM_ABBR

        by_category = {c.get("name"): c for c in side.get("leaders") or []}
        for category in _LEADER_CATEGORIES:
            entry = by_category.get(category) or {}
            best = next(iter(entry.get("leaders") or []), None)
            if not best:
                continue

            athlete = best.get("athlete") or {}
            name = athlete.get("displayName") or athlete.get("fullName")
            if not name:
                continue

            leaders.append(
                GameLeader(
                    category=category,
                    category_label=entry.get("displayName") or category,
                    team_abbr=abbreviation,
                    panthers=panthers,
                    name=name,
                    jersey=athlete.get("jersey"),
                    position=(athlete.get("position") or {}).get("abbreviation"),
                    headshot=(athlete.get("headshot") or {}).get("href"),
                    display_value=best.get("displayValue"),
                )
            )

    return leaders


def _situation(
    competition: Dict[str, Any], panthers: LiveTeam, opponent: LiveTeam
) -> Optional[LiveSituation]:
    """Down, distance and possession — only present while a game is live."""
    raw = competition.get("situation")
    if not isinstance(raw, dict):
        return None

    possession_id = str(raw.get("possession") or "")
    by_id = {panthers.id: panthers, opponent.id: opponent}
    offense = by_id.get(possession_id)

    # ESPN spots the ball relative to the home goal line; the offense's distance
    # to the end zone therefore depends on which way it's going.
    yards_to_endzone = None
    yard_line = raw.get("yardLine")
    if offense is not None and isinstance(yard_line, (int, float)):
        yards_to_endzone = (
            100 - int(yard_line) if offense.home else int(yard_line)
        )
        if not 0 <= yards_to_endzone <= 100:
            yards_to_endzone = None

    home_timeouts = raw.get("homeTimeouts")
    away_timeouts = raw.get("awayTimeouts")

    return LiveSituation(
        possession=offense.abbreviation if offense else None,
        down_distance=raw.get("downDistanceText"),
        short_down_distance=raw.get("shortDownDistanceText"),
        spot=raw.get("possessionText"),
        yards_to_endzone=yards_to_endzone,
        last_play=((raw.get("lastPlay") or {}).get("text") or "").strip() or None,
        red_zone=bool(raw.get("isRedZone")),
        panthers_timeouts=home_timeouts if panthers.home else away_timeouts,
        opponent_timeouts=away_timeouts if panthers.home else home_timeouts,
    )


def _pickcenter_line(payload: Dict[str, Any]) -> tuple:
    """The book's phrasing of the line and the total, for the pre-game card.

    `pickcenter` is the summary endpoint's own odds block, so this needs no
    second request — unlike the schedule's per-game lines, which are keyed on
    the event and fetched separately.
    """
    for book in payload.get("pickcenter") or []:
        details = _clean_text(book.get("details"))
        over_under = book.get("overUnder")
        if details or isinstance(over_under, (int, float)):
            return (
                details,
                float(over_under) if isinstance(over_under, (int, float)) else None,
            )
    return None, None


def _matchup_name(panthers: LiveTeam, opponent: LiveTeam) -> str:
    away, home = (opponent, panthers) if panthers.home else (panthers, opponent)
    return f"{away.name} at {home.name}"


def _selection_from_summary(payload: Dict[str, Any]) -> Dict[str, Any]:
    """The scheduling facts `_select_event` supplies, read back out of a summary.

    A game reached by id has no schedule entry in hand, but the summary's own
    header carries the same week, season and broadcast — everything except the
    matchup's name, which the two teams spell out anyway.
    """
    header = payload.get("header") or {}
    season = header.get("season") or {}
    competition = (header.get("competitions") or [{}])[0]
    return {
        "week": header.get("week"),
        "season": season.get("year") or current_season(),
        "season_type": season.get("type") or _ESPN_REGULAR_SEASON,
        "name": None,
        "short_name": None,
        "network": _network(competition),
    }


def _summary_to_live_game(
    event_id: str, payload: Dict[str, Any], selection: Dict[str, Any]
) -> LiveGame:
    """Adapter: one ESPN summary payload onto the normalized LiveGame.

    Split out from `fetch_live_game` so a finished game can be reached by id
    without going back through "which game should the Live tab show" first.
    """
    header = payload.get("header") or {}
    competitions = header.get("competitions") or []
    if not competitions:
        raise RuntimeError(f"No competition in ESPN summary for event {event_id}")
    competition = competitions[0]

    teams = [
        team
        for team in (
            _competitor_to_live_team(c) for c in competition.get("competitors") or []
        )
        if team is not None
    ]
    panthers = next((t for t in teams if t.panthers), None)
    opponent = next((t for t in teams if not t.panthers), None)
    if panthers is None or opponent is None:
        raise RuntimeError(f"Carolina not found in ESPN summary for event {event_id}")

    status = competition.get("status") or {}
    status_type = status.get("type") or {}
    state = status_type.get("state") or "pre"

    game_info = payload.get("gameInfo") or {}
    venue = game_info.get("venue") or {}
    address = venue.get("address") or {}
    weather = game_info.get("weather") or {}

    line, over_under = _pickcenter_line(payload)
    season_type = int(selection["season_type"])

    game = LiveGame(
        event_id=event_id,
        season=int(selection["season"]),
        season_type=season_type,
        season_label=_SEASON_TYPE_LABELS.get(season_type),
        week=selection["week"],
        # ESPN's summary header doesn't name the matchup, so it's rebuilt from
        # the two teams — visitor first, the way a matchup is always written.
        name=selection.get("name") or _matchup_name(panthers, opponent),
        short_name=selection.get("short_name"),
        state=state,
        completed=bool(status_type.get("completed")),
        status_detail=status_type.get("detail") or status_type.get("description"),
        period=status.get("period") or None,
        clock=status.get("displayClock"),
        kickoff=_parse_espn_datetime(competition.get("date")),
        venue=venue.get("fullName"),
        venue_city=address.get("city"),
        venue_state=address.get("state"),
        attendance=game_info.get("attendance"),
        broadcast=selection.get("network"),
        # A forecast is only worth showing before the game; afterwards the
        # attendance and the result are the facts that matter.
        temperature=weather.get("temperature") if state == "pre" else None,
        precipitation=weather.get("precipitation") if state == "pre" else None,
        line=line,
        over_under=over_under,
        panthers=panthers,
        opponent=opponent,
        situation=_situation(competition, panthers, opponent) if state == "in" else None,
        team_stats=_team_stats(payload.get("boxscore") or {}),
        scoring_plays=_scoring_plays(payload, panthers.home),
        drives=_drives(payload, panthers.home),
        win_probability=_win_probability(payload, panthers.home),
        leaders=_leaders(payload),
        fetched_at=datetime.now(timezone.utc),
    )

    logger.info(
        "Fetched game %s (%s): %d stat rows, %d drives, %d win-prob points",
        event_id,
        state,
        len(game.team_stats),
        len(game.drives),
        len(game.win_probability),
    )
    return game


def fetch_live_game() -> Optional[LiveGame]:
    """The game currently worth watching, as one payload.

    Returns None when Carolina has no game on the current schedule at all, which
    is a genuinely empty tab rather than a failure.
    """
    selection = _select_event()
    if selection is None:
        return None

    event_id = selection["event_id"]
    payload = _fetch_espn_json(ESPN_SUMMARY_URL.format(event=event_id))
    return _summary_to_live_game(event_id, payload, selection)


def fetch_game(event_id: str) -> LiveGame:
    """One game by id, for the recap a schedule row links to.

    Same payload and same adapter as the live tab — a finished game is only a
    live one that stopped changing — which is what lets every chart written for
    kickoff work on a game from October.

    Raises when Carolina isn't in it, so an arbitrary event id can't turn this
    into a general-purpose NFL proxy.
    """
    payload = _fetch_espn_json(ESPN_SUMMARY_URL.format(event=event_id))
    return _summary_to_live_game(event_id, payload, _selection_from_summary(payload))
