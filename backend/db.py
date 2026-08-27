"""Postgres access for the Talk tab.

Every SQL statement in the app lives here, the way every upstream HTTP call
lives in `sources.py` — nothing outside this module knows the schema. Raw SQL
rather than an ORM: there are four tables, and psycopg's dict rows already hand
back exactly what the pydantic models want.

The pool is opened lazily so importing this module never touches the network,
which keeps `main.py` importable without a database (the news half of the app
does not need one).
"""

import logging
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

import config

logger = logging.getLogger(__name__)

SCHEMA_FILE = Path(__file__).resolve().parent / "schema.sql"

# Bounded low: Render runs one process and Neon's free compute is small. The
# pool exists to avoid a connect per request, not to fan out concurrency.
_POOL_MIN_SIZE = 1
_POOL_MAX_SIZE = 10

_pool: Optional[ConnectionPool] = None
_pool_lock = threading.Lock()


def pool() -> ConnectionPool:
    """The process-wide connection pool, opened on first use."""
    global _pool
    if _pool is not None:
        return _pool

    with _pool_lock:
        # Re-check: two threads can pass the fast path above simultaneously.
        if _pool is None:
            _pool = ConnectionPool(
                conninfo=config.require("DATABASE_URL"),
                min_size=_POOL_MIN_SIZE,
                max_size=_POOL_MAX_SIZE,
                kwargs={"row_factory": dict_row},
                # Neon scales compute to zero after ~5 minutes idle, which
                # drops pooled connections on the floor. Without this check the
                # first request after a quiet spell gets handed a dead socket;
                # with it, the pool discards and reconnects transparently.
                check=ConnectionPool.check_connection,
                max_idle=240,
                timeout=15,
            )
            _pool.open()

    return _pool


def init_schema() -> None:
    """Apply schema.sql. Idempotent, so it runs on every boot."""
    statements = SCHEMA_FILE.read_text(encoding="utf-8")
    with pool().connection() as conn:
        conn.execute(statements)
    logger.info("Talk schema ready")


def ping() -> bool:
    """Whether the database is reachable, for /api/health."""
    try:
        with pool().connection() as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        logger.exception("Database ping failed")
        return False


# --- Users and sessions ------------------------------------------------------
SESSION_TTL_DAYS = 30


def upsert_user(
    google_sub: str,
    email: str,
    display_name: str,
    avatar_url: Optional[str],
) -> Dict[str, Any]:
    """Create the user, or refresh the profile Google just gave us.

    Matched on `google_sub`: it is the only identifier Google promises is
    stable, and keying on email would let a reassigned address inherit an
    existing account.
    """
    with pool().connection() as conn:
        row = conn.execute(
            """
            INSERT INTO users (google_sub, email, display_name, avatar_url)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (google_sub) DO UPDATE
               SET email        = EXCLUDED.email,
                   display_name = EXCLUDED.display_name,
                   avatar_url   = EXCLUDED.avatar_url
            RETURNING id, email, display_name, avatar_url, is_banned
            """,
            (google_sub, email, display_name, avatar_url),
        ).fetchone()
    return row


# The app's own account, used for the game thread it opens at kickoff. The
# subject is synthetic: Google issues numeric subs and there is no other login
# path, so nobody can ever sign in as this row — it exists to satisfy the
# author foreign key, which is cheaper than making posts.author_id nullable and
# teaching every query about a second kind of author.
SYSTEM_GOOGLE_SUB = "system:game-thread"
SYSTEM_DISPLAY_NAME = "Panthers Portal"


def system_user() -> int:
    """The app's own user id, created on first use."""
    row = upsert_user(
        google_sub=SYSTEM_GOOGLE_SUB,
        # Never served — PostAuthor has no email field — and unroutable by
        # construction, so a bounce can't leak it either.
        email="noreply@panthers-portal.invalid",
        display_name=SYSTEM_DISPLAY_NAME,
        avatar_url=None,
    )
    return row["id"]


def create_session(user_id: int, token: str) -> None:
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)
    with pool().connection() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (%s, %s, %s)",
            (token, user_id, expires),
        )


def session_user(token: str) -> Optional[Dict[str, Any]]:
    """The user behind a session cookie, or None if it's unknown or expired."""
    with pool().connection() as conn:
        return conn.execute(
            """
            SELECT u.id, u.email, u.display_name, u.avatar_url, u.is_banned
              FROM sessions s
              JOIN users u ON u.id = s.user_id
             WHERE s.token = %s AND s.expires_at > now()
            """,
            (token,),
        ).fetchone()


def delete_session(token: str) -> None:
    with pool().connection() as conn:
        conn.execute("DELETE FROM sessions WHERE token = %s", (token,))


def purge_expired_sessions() -> int:
    """Drop dead sessions. Called on startup; nothing depends on it running."""
    with pool().connection() as conn:
        result = conn.execute("DELETE FROM sessions WHERE expires_at <= now()")
        return result.rowcount


# --- Posts -------------------------------------------------------------------
# Selected for every post shape. Deleted rows never send their body to the
# client: the tombstone exists to hold the thread together, not to keep
# publishing what someone removed.
_POST_COLUMNS = """
    p.id,
    p.parent_id,
    p.created_at,
    p.edited_at,
    p.event_id,
    (p.deleted_at IS NOT NULL)                     AS deleted,
    CASE WHEN p.deleted_at IS NULL THEN p.body END AS body,
    u.id           AS author_id,
    u.display_name AS author_name,
    u.avatar_url   AS author_avatar
"""

# How many names a single emoji's hover carries. Beyond a dozen the tooltip
# stops being readable and starts being a list, and the count already says how
# many there were in total.
MAX_REACTOR_NAMES = 12

# Reaction tallies, the viewer's own picks and who reacted, aggregated in SQL.
# Doing this per post in Python is the N+1 that would make the feed crawl first.
_REACTION_COLUMNS = f"""
    COALESCE((
        SELECT jsonb_object_agg(emoji, n)
          FROM (SELECT emoji, count(*) AS n
                  FROM reactions WHERE post_id = p.id GROUP BY emoji) tally
    ), '{{}}'::jsonb) AS reactions,
    COALESCE((
        SELECT array_agg(emoji) FROM reactions
         WHERE post_id = p.id AND user_id = %(viewer_id)s
    ), ARRAY[]::text[]) AS viewer_reactions,
    -- Who reacted, for the hover. Capped per emoji: the count above is the
    -- truth about how many, and a tooltip that grows without limit would be
    -- both unreadable and a way to make the feed payload arbitrarily large.
    COALESCE((
        SELECT jsonb_object_agg(emoji, names)
          FROM (SELECT r.emoji,
                       (array_agg(ru.display_name ORDER BY r.created_at, ru.id)
                        )[1:{MAX_REACTOR_NAMES}] AS names
                  FROM reactions r
                  JOIN users ru ON ru.id = r.user_id
                 WHERE r.post_id = p.id
                 GROUP BY r.emoji) named
    ), '{{}}'::jsonb) AS reactors
"""

_REPLY_COUNT = """
    (SELECT count(*) FROM posts r
      WHERE r.parent_id = p.id AND r.deleted_at IS NULL) AS reply_count
"""


def list_feed(
    limit: int,
    viewer_id: Optional[int] = None,
    before_created: Optional[datetime] = None,
    before_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Top-level posts, newest first, one page at a time.

    Paginated by keyset rather than OFFSET. A newest-first feed gains rows at
    the head constantly, and an offset would silently skip and repeat posts
    every time someone posted mid-scroll.

    A deleted post is included only while it still has live replies, so the
    conversation underneath it survives; otherwise it drops out entirely.
    """
    sql = f"""
        SELECT {_POST_COLUMNS}, {_REPLY_COUNT}, {_REACTION_COLUMNS}
          FROM posts p
          JOIN users u ON u.id = p.author_id
         WHERE p.parent_id IS NULL
           AND (
                p.deleted_at IS NULL
                OR EXISTS (SELECT 1 FROM posts r
                            WHERE r.parent_id = p.id AND r.deleted_at IS NULL)
           )
           AND (
                %(before_created)s::timestamptz IS NULL
                OR (p.created_at, p.id) < (%(before_created)s, %(before_id)s)
           )
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT %(limit)s
    """
    params = {
        "viewer_id": viewer_id,
        "before_created": before_created,
        "before_id": before_id,
        "limit": limit,
    }
    with pool().connection() as conn:
        return conn.execute(sql, params).fetchall()


def list_replies(post_id: int, viewer_id: Optional[int] = None) -> List[Dict[str, Any]]:
    """Replies to one post, oldest first — reading order for a conversation.

    Deleted replies are dropped outright. Nothing hangs off them, so unlike a
    top-level post there is no thread for a tombstone to hold together.
    """
    sql = f"""
        SELECT {_POST_COLUMNS}, {_REACTION_COLUMNS}
          FROM posts p
          JOIN users u ON u.id = p.author_id
         WHERE p.parent_id = %(post_id)s AND p.deleted_at IS NULL
         ORDER BY p.created_at ASC, p.id ASC
    """
    with pool().connection() as conn:
        return conn.execute(sql, {"post_id": post_id, "viewer_id": viewer_id}).fetchall()


def get_post(post_id: int, viewer_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    sql = f"""
        SELECT {_POST_COLUMNS}, {_REPLY_COUNT}, {_REACTION_COLUMNS}
          FROM posts p
          JOIN users u ON u.id = p.author_id
         WHERE p.id = %(post_id)s
    """
    with pool().connection() as conn:
        return conn.execute(sql, {"post_id": post_id, "viewer_id": viewer_id}).fetchone()


class ReplyDepthError(ValueError):
    """Attempted to reply to a reply. Threads are one level deep."""


class ParentMissingError(ValueError):
    """Attempted to reply to a post that does not exist or was deleted."""


def create_post(author_id: int, body: str, parent_id: Optional[int] = None) -> int:
    """Insert a post or a reply, returning its id.

    The parent check and the insert share one transaction so a parent deleted
    between the two cannot leave a reply orphaned under a tombstone.
    """
    with pool().connection() as conn:
        if parent_id is not None:
            parent = conn.execute(
                "SELECT parent_id, deleted_at FROM posts WHERE id = %s FOR UPDATE",
                (parent_id,),
            ).fetchone()

            if parent is None or parent["deleted_at"] is not None:
                raise ParentMissingError(parent_id)
            # Flat threads: a reply's parent must itself be top-level.
            if parent["parent_id"] is not None:
                raise ReplyDepthError(parent_id)

        row = conn.execute(
            "INSERT INTO posts (author_id, parent_id, body) VALUES (%s, %s, %s) RETURNING id",
            (author_id, parent_id, body),
        ).fetchone()

    return row["id"]


def post_author(post_id: int) -> Optional[int]:
    """Who wrote a post, for the ownership check on delete."""
    with pool().connection() as conn:
        row = conn.execute(
            "SELECT author_id FROM posts WHERE id = %s AND deleted_at IS NULL",
            (post_id,),
        ).fetchone()
    return row["author_id"] if row else None


def soft_delete_post(post_id: int) -> bool:
    with pool().connection() as conn:
        result = conn.execute(
            "UPDATE posts SET deleted_at = now() WHERE id = %s AND deleted_at IS NULL",
            (post_id,),
        )
        return result.rowcount > 0


# --- Game threads ------------------------------------------------------------
def create_game_thread(author_id: int, body: str, event_id: str) -> Optional[int]:
    """Open the thread for one game, returning its id — or None if it exists.

    `ON CONFLICT DO NOTHING` against the partial unique index is what makes this
    safe to call on every poll: the second caller writes nothing and learns so
    from an empty result, with no read-then-write race to lose. The index is
    partial, so its predicate has to be repeated here for conflict inference to
    match it.
    """
    with pool().connection() as conn:
        row = conn.execute(
            """
            INSERT INTO posts (author_id, body, event_id)
            VALUES (%s, %s, %s)
            ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
            RETURNING id
            """,
            (author_id, body, event_id),
        ).fetchone()

    return row["id"] if row else None


def game_thread(event_id: str, viewer_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """One game's thread, in the same shape as any other post."""
    sql = f"""
        SELECT {_POST_COLUMNS}, {_REPLY_COUNT}, {_REACTION_COLUMNS}
          FROM posts p
          JOIN users u ON u.id = p.author_id
         WHERE p.event_id = %(event_id)s AND p.deleted_at IS NULL
    """
    with pool().connection() as conn:
        return conn.execute(
            sql, {"event_id": event_id, "viewer_id": viewer_id}
        ).fetchone()


# --- Reactions ---------------------------------------------------------------
def toggle_reaction(post_id: int, user_id: int, emoji: str) -> bool:
    """Add the reaction, or remove it if this user already picked it.

    Returns True when the reaction is now on. The delete runs first and its
    row count tells us which way the toggle went, which keeps the whole thing
    to one round trip in the common case and avoids a read-then-write race.
    """
    with pool().connection() as conn:
        removed = conn.execute(
            "DELETE FROM reactions WHERE post_id = %s AND user_id = %s AND emoji = %s",
            (post_id, user_id, emoji),
        ).rowcount
        if removed:
            return False

        try:
            conn.execute(
                "INSERT INTO reactions (post_id, user_id, emoji) VALUES (%s, %s, %s)",
                (post_id, user_id, emoji),
            )
        except psycopg.errors.ForeignKeyViolation:
            # The post was deleted between the client seeing it and reacting.
            raise ParentMissingError(post_id)

    return True
