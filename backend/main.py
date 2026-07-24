"""Carolina Panthers portal API.

Read-through in-memory caches over the official Panthers RSS feed (news) and
ESPN's public team endpoint (schedule). No scheduler, no Redis, no database.
"""

import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Hashable, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from models import Article, ArticleContent, Game, Player, Standings
from sources import (
    current_season,
    fetch_article_body,
    fetch_espn_articles,
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
    ):
        self.name = name
        self.ttl_seconds = ttl_seconds
        self.unavailable_detail = unavailable_detail
        self.max_entries = max_entries
        self._entries: Dict[Hashable, _Entry] = {}

    def age_seconds(self, key: Hashable = None) -> Optional[float]:
        entry = self._entries.get(key)
        if entry is None:
            return None
        return (datetime.now(timezone.utc) - entry.fetched_at).total_seconds()

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
        if age is not None and age < self.ttl_seconds:
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


def get_standings(season: int) -> Standings:
    """The division table, falling back to last season before kickoff.

    ESPN publishes the coming season's standings months early with every team
    at 0-0; showing that is worse than showing the season that just finished,
    so an all-zero table is replaced by the previous one and flagged final.
    """

    def load() -> Standings:
        standings = fetch_standings(season)
        if not standings_are_empty(standings):
            # A past season's numbers are done changing; the current one's aren't.
            standings.final = season < current_season()
            return standings

        logger.info("Season %d hasn't started; using %d standings", season, season - 1)
        previous = fetch_standings(season - 1)
        previous.final = True
        return previous

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
app = FastAPI(title="Panthers Portal API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in FRONTEND_ORIGINS if o.strip()],
    allow_methods=["GET"],
    allow_headers=["*"],
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
        "cached_article_bodies": _content_cache.entry_count(),
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
