import { FormEvent, useEffect, useState } from "react";
import { ApiError, createPost, fetchFeed, Post } from "./api";
import { useAuth, useAuthResult } from "./auth";
import { ClawMark } from "./ClawMark";
import { PostCard } from "./PostCard";

type Status = "loading" | "error" | "ready";

const MAX_LENGTH = 500;
// Only start nagging about length near the limit; a counter on an empty box is
// noise.
const COUNTER_VISIBLE_AT = MAX_LENGTH - 100;

/** Feedback from the OAuth round trip, which lands as ?auth=... */
function AuthBanner() {
  const result = useAuthResult();
  if (!result || result === "ok") return null;

  const message =
    result === "denied"
      ? "Sign-in was cancelled."
      : result === "banned"
        ? "This account can’t post here."
        : "Sign-in didn’t work. Please try again.";

  return (
    <div className="talk-banner" role="status">
      {message}
    </div>
  );
}

function Composer({ onPosted }: { onPosted: (post: Post) => void }) {
  const { user, loading, signIn, signOut } = useAuth();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held back until we know: flashing the sign-in prompt at someone who is
  // already signed in is worse than a beat of nothing.
  if (loading) return <div className="talk-composer talk-composer-skeleton" />;

  if (!user) {
    return (
      <div className="talk-signin">
        <ClawMark className="talk-signin-claw" />
        <div>
          <h2 className="talk-signin-title">Join the conversation</h2>
          <p className="meta">
            Anyone can read. Sign in to post, reply and react.
          </p>
        </div>
        <button type="button" className="talk-btn talk-btn-primary" onClick={signIn}>
          Sign in with Google
        </button>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || busy) return;

    setBusy(true);
    setError(null);
    try {
      onPosted(await createPost(body.trim()));
      setBody("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn’t post that");
    } finally {
      setBusy(false);
    }
  }

  const remaining = MAX_LENGTH - body.length;

  return (
    <form className="talk-composer" onSubmit={submit}>
      <textarea
        className="talk-input"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={`What’s on your mind, ${user.display_name.split(" ")[0]}?`}
        maxLength={MAX_LENGTH}
        rows={3}
        aria-label="Write a post"
      />
      <div className="talk-composer-foot">
        <span className="meta talk-signed-in">
          {user.display_name}
          <button type="button" className="talk-link" onClick={signOut}>
            Sign out
          </button>
        </span>
        <div className="talk-composer-actions">
          {body.length >= COUNTER_VISIBLE_AT && (
            <span className={`meta${remaining < 0 ? " talk-inline-error" : ""}`}>
              {remaining}
            </span>
          )}
          <button
            className="talk-btn talk-btn-primary"
            type="submit"
            disabled={!body.trim() || busy}
          >
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
      {error && <p className="talk-inline-error">{error}</p>}
    </form>
  );
}

export function Talk() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [loadingMore, setLoadingMore] = useState(false);

  // Not routed through api.ts's `cached()` helper: it never invalidates, so a
  // cached feed would go stale the moment anyone posted.
  useEffect(() => {
    let active = true;
    fetchFeed()
      .then((feed) => {
        if (!active) return;
        setPosts(feed.posts);
        setCursor(feed.next_cursor);
        setStatus("ready");
      })
      .catch(() => active && setStatus("error"));
    return () => {
      active = false;
    };
  }, []);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const feed = await fetchFeed(cursor);
      // Guard against a post arriving in both pages, which a keyset cursor
      // makes unlikely but a deletion between requests can still produce.
      setPosts((current) => {
        const seen = new Set(current.map((p) => p.id));
        return [...current, ...feed.posts.filter((p) => !seen.has(p.id))];
      });
      setCursor(feed.next_cursor);
    } catch {
      // Leave what's already loaded alone; the button stays available.
    } finally {
      setLoadingMore(false);
    }
  }

  function patch(id: number, changes: Partial<Post>) {
    setPosts((current) =>
      current.map((p) => (p.id === id ? { ...p, ...changes } : p)),
    );
  }

  function removed(id: number) {
    // Mirrors the server: a deleted post with replies stays as a tombstone so
    // the thread under it survives; one without simply goes.
    setPosts((current) =>
      current.flatMap((p) => {
        if (p.id !== id) return [p];
        return p.reply_count > 0 ? [{ ...p, deleted: true, body: null }] : [];
      }),
    );
  }

  return (
    <>
      <AuthBanner />
      <Composer onPosted={(post) => setPosts((current) => [post, ...current])} />

      <div className="section-head">
        <h2 className="section-title">Fan Talk</h2>
        <span className="section-rule" />
      </div>

      {status === "loading" && (
        <ul className="talk-list">
          {Array.from({ length: 4 }).map((_, i) => (
            <li className="talk-post" key={i}>
              <div className="skeleton talk-avatar" />
              <div className="talk-post-body">
                <div className="skeleton skeleton-line short" />
                <div className="skeleton skeleton-line long" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {status === "error" && (
        <div className="notice">
          <ClawMark className="notice-claw" />
          <h2>We dropped the ball</h2>
          <p>Talk couldn’t be loaded. Please try again shortly.</p>
        </div>
      )}

      {status === "ready" && posts.length === 0 && (
        <div className="notice">
          <ClawMark className="notice-claw" />
          <h2>Nobody’s said anything yet</h2>
          <p>Be the first to get the conversation going.</p>
        </div>
      )}

      {status === "ready" && posts.length > 0 && (
        <ul className="talk-list">
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              onChange={(changes) => patch(post.id, changes)}
              onRemoved={() => removed(post.id)}
            />
          ))}
        </ul>
      )}

      {status === "ready" && cursor && (
        <div className="talk-more">
          <button
            type="button"
            className="talk-btn"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
