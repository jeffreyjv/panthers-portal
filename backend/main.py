"""Carolina Panthers portal API.

Read-through in-memory caches over the official Panthers RSS feed (news) and
ESPN's public team endpoint (schedule). No scheduler, no Redis, no database.
"""

import base64
import logging
import os
import re
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Deque, Dict, Hashable, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Imported first: loads backend/.env into the environment before anything below
# reads a setting at module level.
import config  # noqa: F401  (imported for its side effect)
import auth
import db
from models import (
    Article,
    ArticleContent,
    CurrentUser,
    Feed,
    Game,
    GameLine,
    Injury,
    LiveGame,
    Odds,
    Player,
    Post,
    PostAuthor,
    PostCreate,
    ReactionCreate,
    ReactionResult,
    Standings,
    TeamStanding,
)
from sources import (
    current_season,
    fetch_article_body,
    fetch_espn_articles,
    fetch_futures,
    fetch_game,
    fetch_game_odds,
    fetch_injuries,
    fetch_live_game,
    fetch_panthers_articles,
    fetch_panthers_roster,
    fetch_panthers_schedule,
    fetch_standings,
    standings_are_empty,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Config (env vars with sane defaults) ------------------------------------
FEED_URL = os.getenv("PANTHERS_FEED_URL", "https://www.panthers.com/rss/news")
CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "600"))
# How many ESPN items to pull; they're merged into the same feed.
ESPN_NEWS_LIMIT = int(os.getenv("ESPN_NEWS_LIMIT", "50"))
# Cap on the merged feed, applied after sorting and dedupe so the 50 that
# survive are the newest across both sources rather than the newest of either.
NEWS_LIMIT = int(os.getenv("NEWS_LIMIT", "50"))
# The schedule and roster barely move; refetch far less often than the news feed.
SCHEDULE_CACHE_TTL_SECONDS = int(os.getenv("SCHEDULE_CACHE_TTL_SECONDS", "3600"))
ROSTER_CACHE_TTL_SECONDS = int(os.getenv("ROSTER_CACHE_TTL_SECONDS", "3600"))
# The injury report turns over faster than the roster — practice reports land
# through the afternoon — but nowhere near as fast as the news feed.
INJURY_CACHE_TTL_SECONDS = int(os.getenv("INJURY_CACHE_TTL_SECONDS", "900"))
# Lines move continuously, but this is a fan page showing roughly where the
# market sits, not a live betting screen — nobody should be acting on the last
# refresh of it either way.
ODDS_CACHE_TTL_SECONDS = int(os.getenv("ODDS_CACHE_TTL_SECONDS", "900"))
# ESPN prices one game per request, so a cold cache means ~17 of them. Fetched
# through a small pool: enough to keep that off the critical path, low enough
# not to arrive at ESPN as a burst.
ODDS_FETCH_WORKERS = int(os.getenv("ODDS_FETCH_WORKERS", "6"))
# The live game is the one thing here that genuinely moves by the second, so its
# TTL is picked from the game's own state rather than being fixed — see
# `_live_ttl`. These are the three states it chooses between.
LIVE_CACHE_TTL_SECONDS = int(os.getenv("LIVE_CACHE_TTL_SECONDS", "15"))
# Nothing about a scheduled game changes, but the flip to "in progress" has to be
# noticed promptly, so the wait shortens as kickoff approaches.
LIVE_PREGAME_TTL_SECONDS = int(os.getenv("LIVE_PREGAME_TTL_SECONDS", "300"))
LIVE_KICKOFF_TTL_SECONDS = int(os.getenv("LIVE_KICKOFF_TTL_SECONDS", "30"))
LIVE_KICKOFF_WINDOW_SECONDS = int(os.getenv("LIVE_KICKOFF_WINDOW_SECONDS", "1800"))
# A final box score is settled; ESPN still corrects stats for a while afterwards,
# which is what this refetch is for rather than anything a viewer is waiting on.
LIVE_FINAL_TTL_SECONDS = int(os.getenv("LIVE_FINAL_TTL_SECONDS", "900"))
# A game reached by id is nearly always one that finished weeks ago, so the
# recap route holds each one for a day and bounds how many it keeps.
GAME_CACHE_MAX_ENTRIES = int(os.getenv("GAME_CACHE_MAX_ENTRIES", "60"))
GAME_FINAL_TTL_SECONDS = int(os.getenv("GAME_FINAL_TTL_SECONDS", "86400"))
# Published article bodies effectively never change.
CONTENT_CACHE_TTL_SECONDS = int(os.getenv("CONTENT_CACHE_TTL_SECONDS", "86400"))
CONTENT_CACHE_MAX_ENTRIES = int(os.getenv("CONTENT_CACHE_MAX_ENTRIES", "200"))
FRONTEND_ORIGINS = os.getenv(
    "FRONTEND_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")
# Built frontend, served from this app in production so the API is same-origin.
# Resolved off this file rather than the cwd so it holds wherever uvicorn starts.
FRONTEND_DIST = Path(
    os.getenv("FRONTEND_DIST", Path(__file__).resolve().parent.parent / "frontend" / "dist")
).resolve()


# --- Read-through cache ------------------------------------------------------
@dataclass
class _Entry:
    value: Any
    fetched_at: datetime


class ReadThroughCache:
    """TTL cache keyed by request parameters.

    Serves fresh values from memory, refetches when stale, and falls back to
    the last known-good value if the upstream refetch fails.
    """

    def __init__(
        self,
        name: str,
        ttl_seconds: int,
        unavailable_detail: str,
        max_entries: Optional[int] = None,
        ttl_of: Optional[Callable[[Any], int]] = None,
    ):
        self.name = name
        self.ttl_seconds = ttl_seconds
        self.unavailable_detail = unavailable_detail
        self.max_entries = max_entries
        # Lets a cache set its own TTL from what it's holding. Only the live game
        # needs this: the same payload is worth seconds during a game and an hour
        # after it, and that is a property of the value, not of the route.
        self.ttl_of = ttl_of
        self._entries: Dict[Hashable, _Entry] = {}

    def age_seconds(self, key: Hashable = None) -> Optional[float]:
        entry = self._entries.get(key)
        if entry is None:
            return None
        return (datetime.now(timezone.utc) - entry.fetched_at).total_seconds()

    def _ttl_for(self, value: Any) -> int:
        return self.ttl_of(value) if self.ttl_of else self.ttl_seconds

    def size(self, key: Hashable = None) -> int:
        entry = self._entries.get(key)
        return len(entry.value) if entry else 0

    def entry_count(self) -> int:
        return len(self._entries)

    def _evict(self) -> None:
        """Drop the oldest entries once the cache outgrows its bound."""
        if self.max_entries is None:
            return
        while len(self._entries) > self.max_entries:
            oldest = min(self._entries, key=lambda k: self._entries[k].fetched_at)
            del self._entries[oldest]

    def get(self, loader: Callable[[], Any], key: Hashable = None) -> Any:
        age = self.age_seconds(key)
        if age is not None and age < self._ttl_for(self._entries[key].value):
            return self._entries[key].value

        try:
            value = loader()
            self._entries[key] = _Entry(value, datetime.now(timezone.utc))
            self._evict()
            return value
        except Exception:
            logger.exception("Refetch failed for %s (key=%s)", self.name, key)
            if key in self._entries:
                logger.warning("Serving stale %s cache (age=%ss)", self.name, age)
                return self._entries[key].value
            raise HTTPException(status_code=503, detail=self.unavailable_detail)


_articles_cache = ReadThroughCache(
    "articles", CACHE_TTL_SECONDS, "News feed unavailable"
)
_schedule_cache = ReadThroughCache(
    "schedule", SCHEDULE_CACHE_TTL_SECONDS, "Schedule unavailable"
)
_roster_cache = ReadThroughCache(
    "roster", ROSTER_CACHE_TTL_SECONDS, "Roster unavailable"
)
# Standings move once a week at most, so they ride the schedule's TTL.
_standings_cache = ReadThroughCache(
    "standings", SCHEDULE_CACHE_TTL_SECONDS, "Standings unavailable"
)
_injuries_cache = ReadThroughCache(
    "injuries", INJURY_CACHE_TTL_SECONDS, "Injury report unavailable"
)
_odds_cache = ReadThroughCache("odds", ODDS_CACHE_TTL_SECONDS, "Odds unavailable")


def _live_ttl(game: Optional[LiveGame]) -> int:
    """How long a live-game snapshot stays good for.

    A game in progress is worth refetching on the order of seconds; a scheduled
    one changes only when it starts, so the only reason to poll it is to catch
    that moment; a final one is done. Without this the route would either hammer
    ESPN all week or lag a touchdown by ten minutes.
    """
    if game is None:
        return LIVE_PREGAME_TTL_SECONDS
    if game.state == "in":
        return LIVE_CACHE_TTL_SECONDS
    if game.state == "pre":
        if game.kickoff is None:
            return LIVE_PREGAME_TTL_SECONDS
        until_kickoff = (game.kickoff - datetime.now(timezone.utc)).total_seconds()
        return (
            LIVE_KICKOFF_TTL_SECONDS
            if until_kickoff <= LIVE_KICKOFF_WINDOW_SECONDS
            else LIVE_PREGAME_TTL_SECONDS
        )
    return LIVE_FINAL_TTL_SECONDS


_live_cache = ReadThroughCache(
    "live",
    LIVE_CACHE_TTL_SECONDS,
    "Live game data unavailable",
    ttl_of=_live_ttl,
)



def _game_ttl(game: LiveGame) -> int:
    """How long a named game stays good for.

    A final game is over: nothing about it will change again, so it's held for
    a day. Anything else is deferred to the live rules, since a link to today's
    game has to behave like the Live tab rather than freeze on first read.
    """
    return GAME_FINAL_TTL_SECONDS if game.state == "post" else _live_ttl(game)


_game_cache = ReadThroughCache(
    "game",
    GAME_FINAL_TTL_SECONDS,
    "Game data unavailable",
    max_entries=GAME_CACHE_MAX_ENTRIES,
    ttl_of=_game_ttl,
)
_content_cache = ReadThroughCache(
    "content",
    CONTENT_CACHE_TTL_SECONDS,
    "Article text unavailable",
    max_entries=CONTENT_CACHE_MAX_ENTRIES,
)


def _dedupe(articles: List[Article]) -> List[Article]:
    """Drop repeats, keeping the first occurrence.

    Both feeds cover the same beat, so a story can arrive twice. Matching on
    URL catches straight republications and normalized title catches the same
    story filed under two links; anything looser would collapse genuinely
    different stories about one event.
    """
    seen: set = set()
    unique: List[Article] = []

    for article in articles:
        title_key = re.sub(r"[^a-z0-9]+", " ", article.title.lower()).strip()
        keys = {("url", article.url.rstrip("/").lower()), ("title", title_key)}
        if seen & keys:
            continue
        seen |= keys
        unique.append(article)

    return unique


def get_articles() -> List[Article]:
    """News from both feeds, merged newest-first.

    Each source is fetched independently so one going down degrades the feed
    rather than emptying it; only losing both is an error, which lets the
    cache fall back to its last known-good value.
    """

    def load() -> List[Article]:
        articles: List[Article] = []
        failures = 0

        # panthers.com goes first so it wins ties during dedupe: it is the
        # official source, and its pages are the ones the reader can extract.
        for name, fetch in (
            ("panthers.com", lambda: fetch_panthers_articles(FEED_URL)),
            ("espn.com", lambda: fetch_espn_articles(ESPN_NEWS_LIMIT)),
        ):
            try:
                articles.extend(fetch())
            except Exception:
                failures += 1
                logger.exception("News source %s failed", name)

        if failures == 2:
            raise RuntimeError("Every news source failed")

        articles.sort(
            key=lambda a: a.published_at or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        return _dedupe(articles)[:NEWS_LIMIT]

    return _articles_cache.get(load)


def get_schedule(season: int) -> List[Game]:
    return _schedule_cache.get(lambda: fetch_panthers_schedule(season), key=season)


def get_roster(season: int) -> List[Player]:
    return _roster_cache.get(lambda: fetch_panthers_roster(season), key=season)


def get_injuries() -> List[Injury]:
    return _injuries_cache.get(fetch_injuries)


def _load_lines(season: int) -> Dict[int, GameLine]:
    """The line on every game still to be played, keyed by week.

    ESPN prices one event per request, so this is a fan-out — hence the pool.
    Games already final are skipped: their result is on the row, which is more
    than the closing line was ever going to tell anyone.

    A single game failing is dropped rather than raised. One unpriced event
    should cost that row its odds, not the whole schedule its strip.
    """
    games = [
        game
        for game in get_schedule(season)
        if not game.bye and game.event_id and game.status != "final"
    ]
    if not games:
        return {}

    lines: Dict[int, GameLine] = {}
    with ThreadPoolExecutor(max_workers=ODDS_FETCH_WORKERS) as pool:
        futures = {
            pool.submit(
                fetch_game_odds, game.event_id, game.week, bool(game.home)
            ): game
            for game in games
        }
        for future in as_completed(futures):
            game = futures[future]
            try:
                line = future.result()
            except RuntimeError:
                logger.exception("Odds unavailable for week %d", game.week)
                continue
            if line is not None:
                lines[game.week] = line

    logger.info("Fetched lines for %d of %d game(s)", len(lines), len(games))
    return lines


def get_odds() -> Odds:
    """Carolina's season futures plus a line on each remaining game."""
    season = current_season()

    def load() -> Odds:
        try:
            season_futures = fetch_futures(season)
        except RuntimeError:
            logger.exception("Futures unavailable for season %d", season)
            season_futures = None

        return Odds(season=season, futures=season_futures, lines=_load_lines(season))

    return _odds_cache.get(load, key=season)


def get_live_game() -> Optional[LiveGame]:
    return _live_cache.get(fetch_live_game)


def _regular_season_started(season: int) -> Optional[bool]:
    """Whether a regular-season game has actually been played yet.

    The standings can't answer this on their own: through August ESPN folds
    preseason results into the regular-season table, so Carolina shows 1-0
    weeks before Week 1 kicks off. The schedule is fetched for seasontype 2
    only, so any game past `scheduled` there is a real regular-season game.

    None when the schedule is unavailable, leaving the caller to fall back.
    """
    try:
        games = get_schedule(season)
    except RuntimeError:
        logger.exception("Schedule unavailable; can't date the start of %d", season)
        return None
    return any(game.status != "scheduled" for game in games)


def _reset_standing(team: TeamStanding) -> TeamStanding:
    """One line, wound back to the start of the season.

    Everything here is a consequence of games played, so before Week 1 none of
    it exists — including the preseason results ESPN folds into the August
    table, which is the whole reason this is done by hand rather than trusted.
    """
    return team.model_copy(
        update={
            "wins": 0,
            "losses": 0,
            "ties": 0,
            "record": "0-0",
            "win_pct": None,
            "streak": None,
            "points_for": None,
            "points_against": None,
            "division_record": None,
            "playoff_seed": None,
            "clinched": None,
        }
    )


def _reset_standings(standings: Standings) -> Standings:
    """The coming season's table with every record zeroed.

    ESPN orders a division by its own tiebreakers, which mean nothing when
    every team is 0-0 — and leaving last season's order in place reads as a
    prediction. Alphabetical is the one order that claims nothing.
    """
    standings.division = sorted(
        (_reset_standing(t) for t in standings.division), key=lambda t: t.name
    )
    standings.league = {
        abbr: _reset_standing(team) for abbr, team in standings.league.items()
    }
    standings.final = False
    standings.preseason = True
    return standings


def get_standings(season: int) -> Standings:
    """The division table, zeroed out before kickoff.

    ESPN publishes the coming season's standings months early and then seeds
    them with preseason results, so Carolina can show 1-0 weeks before Week 1.
    Until the schedule confirms a regular-season game has been played, the
    table is reset to 0-0 rather than shown as ESPN sends it.
    """

    def load() -> Standings:
        standings = fetch_standings(season)
        started = _regular_season_started(season)
        if started is None:
            # No schedule to check against: the all-zero test is all we have.
            started = not standings_are_empty(standings)
        if started:
            # A past season's numbers are done changing; the current one's aren't.
            standings.final = season < current_season()
            return standings

        logger.info("Season %d hasn't started; resetting the table to 0-0", season)
        return _reset_standings(standings)

    return _standings_cache.get(load, key=season)


def get_article_content(article_id: str) -> ArticleContent:
    """Body text for one article from the current feed.

    The id is resolved against the cached feed rather than taking a URL from
    the caller, so this can only ever fetch pages the feed already points at.
    """
    article = next((a for a in get_articles() if a.id == article_id), None)
    if article is None:
        raise HTTPException(status_code=404, detail="Article not found")

    def load() -> ArticleContent:
        return ArticleContent(
            id=article.id,
            url=article.url,
            paragraphs=fetch_article_body(article),
        )

    return _content_cache.get(load, key=article_id)


# --- App ---------------------------------------------------------------------
# Whether the Talk tab has a working database behind it. Flipped on at startup;
# every write route checks it.
talk_ready = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Bring up the Talk schema, without making the rest of the app depend on it.

    A missing DATABASE_URL or an unreachable Neon is logged loudly and disables
    Talk, rather than refusing to boot. The news half of this app has no
    database at all, and taking News, Schedule and Team down over a social
    feature would be the wrong trade — the same reasoning that lets one dead
    news source degrade the feed instead of emptying it.
    """
    global talk_ready
    try:
        db.init_schema()
        purged = db.purge_expired_sessions()
        if purged:
            logger.info("Purged %d expired session(s)", purged)
        talk_ready = True
    except Exception:
        logger.exception(
            "Talk is disabled: the database could not be reached. "
            "Check DATABASE_URL; the rest of the app is unaffected."
        )

    yield


app = FastAPI(title="Panthers Portal API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in FRONTEND_ORIGINS if o.strip()],
    # POST and DELETE arrived with Talk. Credentials are required so the
    # session cookie rides along; that is only legal against an explicit origin
    # list, which FRONTEND_ORIGINS is. Production is same-origin regardless.
    allow_methods=["GET", "POST", "DELETE"],
    allow_credentials=True,
    allow_headers=["*"],
)


def require_talk() -> None:
    """503 when Talk has no database, rather than an opaque connection error."""
    if not talk_ready:
        raise HTTPException(
            status_code=503, detail="Talk is temporarily unavailable"
        )


# --- Rate limiting -----------------------------------------------------------
# Per-user sliding window, held in memory like every other cache in this app.
# That means it resets on restart and does not span replicas — acceptable
# because the README already requires a single instance, and because this
# exists to stop a script hammering the feed, not to meter honest users.
POST_RATE_LIMIT = int(os.getenv("POST_RATE_LIMIT", "5"))
POST_RATE_WINDOW_SECONDS = int(os.getenv("POST_RATE_WINDOW_SECONDS", "60"))

_rate_history: Dict[int, Deque[float]] = {}
_rate_lock = threading.Lock()


def rate_limit(user_id: int) -> None:
    """Raise 429 if this user has posted too often lately.

    Abuse doesn't scale with legitimate traffic: one script can flood a quiet
    site, which is exactly the shape of site this is.
    """
    now = time.monotonic()
    cutoff = now - POST_RATE_WINDOW_SECONDS

    with _rate_lock:
        history = _rate_history.setdefault(user_id, deque())
        while history and history[0] < cutoff:
            history.popleft()

        if len(history) >= POST_RATE_LIMIT:
            retry_after = int(history[0] - cutoff) + 1
            raise HTTPException(
                status_code=429,
                detail="You're posting too quickly. Give it a moment.",
                headers={"Retry-After": str(retry_after)},
            )

        history.append(now)

        # Users who stopped posting shouldn't linger forever. Cheap to sweep
        # here; there is no scheduler in this app to do it elsewhere.
        if len(_rate_history) > 1000:
            for uid in [u for u, h in _rate_history.items() if not h or h[-1] < cutoff]:
                del _rate_history[uid]


app.include_router(auth.router)


# --- Talk --------------------------------------------------------------------
FEED_PAGE_SIZE = int(os.getenv("FEED_PAGE_SIZE", "25"))


def _encode_cursor(row: Dict[str, Any]) -> str:
    """Opaque keyset cursor: the last row's sort key, base64'd.

    Encoded only so it reads as a token rather than something to hand-edit;
    it is not a secret, and nothing trusts its contents beyond parsing.
    """
    raw = f"{row['created_at'].isoformat()}|{row['id']}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: Optional[str]) -> tuple:
    if not cursor:
        return None, None
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        created, _, post_id = raw.partition("|")
        return datetime.fromisoformat(created), int(post_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid cursor")


def _to_post(row: Dict[str, Any]) -> Post:
    """Database row -> API shape."""
    return Post(
        id=row["id"],
        parent_id=row["parent_id"],
        author=PostAuthor(
            id=row["author_id"],
            display_name=row["author_name"],
            avatar_url=row["author_avatar"],
        ),
        body=row["body"],
        created_at=row["created_at"],
        edited_at=row["edited_at"],
        deleted=row["deleted"],
        reply_count=row.get("reply_count", 0),
        reactions=row["reactions"],
        viewer_reactions=list(row["viewer_reactions"]),
    )


@app.get("/api/posts", response_model=Feed)
def feed(
    cursor: Optional[str] = Query(None, description="Opaque cursor from a previous page."),
    limit: int = Query(FEED_PAGE_SIZE, ge=1, le=100),
    viewer: Optional[CurrentUser] = Depends(auth.current_user),
) -> Feed:
    """The Talk feed. Readable signed out — only writing needs an account."""
    require_talk()
    before_created, before_id = _decode_cursor(cursor)

    rows = db.list_feed(
        limit=limit,
        viewer_id=viewer.id if viewer else None,
        before_created=before_created,
        before_id=before_id,
    )

    # A short page means the end of the feed; handing back a cursor there would
    # just cost the client one more request to learn nothing.
    next_cursor = _encode_cursor(rows[-1]) if len(rows) == limit else None
    return Feed(posts=[_to_post(r) for r in rows], next_cursor=next_cursor)


@app.post("/api/posts", response_model=Post, status_code=201)
def create_post(
    payload: PostCreate,
    user: CurrentUser = Depends(auth.require_user),
) -> Post:
    require_talk()
    rate_limit(user.id)
    post_id = db.create_post(author_id=user.id, body=payload.body)
    return _to_post(db.get_post(post_id, viewer_id=user.id))


@app.get("/api/posts/{post_id}/replies", response_model=List[Post])
def replies(
    post_id: int,
    viewer: Optional[CurrentUser] = Depends(auth.current_user),
) -> List[Post]:
    require_talk()
    rows = db.list_replies(post_id, viewer_id=viewer.id if viewer else None)
    return [_to_post(r) for r in rows]


@app.post("/api/posts/{post_id}/replies", response_model=Post, status_code=201)
def create_reply(
    post_id: int,
    payload: PostCreate,
    user: CurrentUser = Depends(auth.require_user),
) -> Post:
    require_talk()
    rate_limit(user.id)

    try:
        reply_id = db.create_post(author_id=user.id, body=payload.body, parent_id=post_id)
    except db.ReplyDepthError:
        raise HTTPException(
            status_code=400, detail="Replies only go one level deep"
        )
    except db.ParentMissingError:
        raise HTTPException(status_code=404, detail="That post is gone")

    return _to_post(db.get_post(reply_id, viewer_id=user.id))


@app.delete("/api/posts/{post_id}", status_code=204)
def delete_post(
    post_id: int,
    user: CurrentUser = Depends(auth.require_user),
) -> Response:
    require_talk()
    author_id = db.post_author(post_id)
    if author_id is None:
        raise HTTPException(status_code=404, detail="That post is gone")
    if author_id != user.id:
        raise HTTPException(status_code=403, detail="That isn't your post")

    db.soft_delete_post(post_id)
    return Response(status_code=204)


@app.post("/api/posts/{post_id}/reactions", response_model=ReactionResult)
def react(
    post_id: int,
    payload: ReactionCreate,
    user: CurrentUser = Depends(auth.require_user),
) -> ReactionResult:
    """Toggle one reaction. The emoji is checked against the allowlist by
    ReactionCreate before this runs."""
    require_talk()

    try:
        db.toggle_reaction(post_id, user.id, payload.emoji)
    except db.ParentMissingError:
        raise HTTPException(status_code=404, detail="That post is gone")

    row = db.get_post(post_id, viewer_id=user.id)
    if row is None:
        raise HTTPException(status_code=404, detail="That post is gone")

    return ReactionResult(
        post_id=post_id,
        reactions=row["reactions"],
        viewer_reactions=list(row["viewer_reactions"]),
    )


@app.get("/api/articles", response_model=List[Article])
def articles() -> List[Article]:
    return get_articles()


@app.get("/api/articles/{article_id}/content", response_model=ArticleContent)
def article_content(article_id: str) -> ArticleContent:
    return get_article_content(article_id)


@app.get("/api/schedule", response_model=List[Game])
def schedule(
    season: Optional[int] = Query(
        None, ge=2000, le=2100, description="Season year; defaults to the current one."
    ),
) -> List[Game]:
    return get_schedule(season or current_season())


@app.get("/api/standings", response_model=Standings)
def standings(
    season: Optional[int] = Query(
        None, ge=2000, le=2100, description="Season year; defaults to the current one."
    ),
) -> Standings:
    return get_standings(season or current_season())


@app.get("/api/roster", response_model=List[Player])
def roster() -> List[Player]:
    return get_roster(current_season())


@app.get("/api/injuries", response_model=List[Injury])
def injuries() -> List[Injury]:
    return get_injuries()


@app.get("/api/odds", response_model=Odds)
def odds() -> Odds:
    return get_odds()


@app.get("/api/live", response_model=Optional[LiveGame])
def live(response: Response) -> Optional[LiveGame]:
    """The game in progress, or the next one, or the last one played.

    Null when Carolina has no game on the current schedule.

    Explicitly uncached downstream. Handing out a max-age here looks like free
    protection but is a trap: the pre-game interval is minutes long, so a browser
    that cached a "scheduled" response would keep replaying it past kickoff and
    the client's own polling could not see the game start. The read-through cache
    in this process is the one that matters, and answering from it is cheap.
    """
    response.headers["Cache-Control"] = "no-store"
    return get_live_game()


@app.get("/api/game/{event_id}", response_model=LiveGame)
def game(event_id: str, response: Response) -> LiveGame:
    """One game by ESPN event id — the same payload the Live tab renders.

    This is what a finished schedule row links to: without it the charts only
    get to exist for three hours a week.

    `no-store` for the same reason as /api/live: a linked-to game can be one
    that is still being played, and the id alone doesn't say which.
    """
    response.headers["Cache-Control"] = "no-store"
    # ESPN event ids are numeric. Anything else can't name a game, so it's
    # turned away here rather than sent upstream to find that out.
    if not event_id.isdigit():
        raise HTTPException(status_code=404, detail="Unknown game")

    # An id that names some other team's game raises in `fetch_game` and comes
    # back as the cache's 503, which is the same answer every other route gives
    # for "can't show you this" and is what the tab already handles.
    return _game_cache.get(lambda: fetch_game(event_id), key=event_id)


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "cache_age_seconds": _articles_cache.age_seconds(),
        "cached_articles": _articles_cache.size(),
        "schedule_cache_age_seconds": _schedule_cache.age_seconds(current_season()),
        "standings_cache_age_seconds": _standings_cache.age_seconds(current_season()),
        "cached_games": _schedule_cache.size(current_season()),
        "cached_players": _roster_cache.size(current_season()),
        "injuries_cache_age_seconds": _injuries_cache.age_seconds(),
        "cached_injuries": _injuries_cache.size(),
        "odds_cache_age_seconds": _odds_cache.age_seconds(current_season()),
        "live_cache_age_seconds": _live_cache.age_seconds(),
        "cached_recaps": _game_cache.entry_count(),
        "cached_article_bodies": _content_cache.entry_count(),
        # Talk's schema came up at startup; `database` is checked live, so a
        # Neon instance that went away since boot shows here.
        "talk_ready": talk_ready,
        "database": db.ping() if talk_ready else False,
    }


# --- Frontend ----------------------------------------------------------------
# Registered last so the catch-all below can never shadow an /api route. Skipped
# entirely when there's no build, which is the normal case in dev: there Vite
# serves the app and proxies /api here.
if FRONTEND_DIST.is_dir():
    app.mount(
        "/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets"
    )

    @app.get("/{full_path:path}")
    def spa(full_path: str) -> FileResponse:
        """Serve a built file if one matches, otherwise the SPA entry point.

        Client-side routes have no file behind them, so unmatched paths fall
        through to index.html and let the app route them.
        """
        # An unknown /api path is a bug, not a client-side route; 404 as JSON
        # rather than handing back HTML that the caller can't parse.
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")

        candidate = (FRONTEND_DIST / full_path).resolve()
        if (
            full_path
            and candidate.is_relative_to(FRONTEND_DIST)  # no ../ escapes
            and candidate.is_file()
        ):
            return FileResponse(candidate)

        return FileResponse(FRONTEND_DIST / "index.html")
