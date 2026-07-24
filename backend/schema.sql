-- Talk tab schema: accounts, sessions, posts and reactions.
--
-- Applied on startup by db.init_schema(). Every statement is idempotent, so
-- this doubles as the migration story: to change the shape, add a new
-- idempotent statement at the end rather than editing one above it.

CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  -- Google's stable subject id. Emails can be reassigned or changed, so
  -- matching on those would be an account-takeover vector.
  google_sub   TEXT UNIQUE NOT NULL,
  email        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_banned    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS sessions (
  -- Opaque random token (secrets.token_urlsafe), not a JWT: revoking a
  -- session is a DELETE, and nothing has to verify a signature.
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Replies are posts with a parent. One table means one insert path and one
-- render path; the "only one level deep" rule is enforced in db.create_post
-- rather than by the schema, which cannot express it.
CREATE TABLE IF NOT EXISTS posts (
  id         BIGSERIAL PRIMARY KEY,
  author_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  BIGINT REFERENCES posts(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at  TIMESTAMPTZ,
  -- Soft delete: a deleted parent still has to hold its replies, so the row
  -- survives and renders as a tombstone.
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reactions (
  post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per person per emoji per post is what makes a reaction a toggle
  -- instead of a counter anyone can run up.
  PRIMARY KEY (post_id, user_id, emoji)
);

-- The feed query: top-level posts, newest first. Partial on parent_id only —
-- deleted posts are not filtered here, because one that still has replies is
-- returned as a tombstone so the conversation under it survives.
CREATE INDEX IF NOT EXISTS posts_feed_idx
  ON posts (created_at DESC, id DESC)
  WHERE parent_id IS NULL;

-- Reply lookups, and the reply-count subquery on the feed.
CREATE INDEX IF NOT EXISTS posts_parent_idx ON posts (parent_id, created_at);

-- Supports the expired-session sweep.
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
