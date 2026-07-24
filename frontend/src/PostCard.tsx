import { FormEvent, useState } from "react";
import {
  ApiError,
  createReply,
  deletePost,
  fetchReplies,
  Post,
  react,
  REACTIONS,
  relativeTime,
} from "./api";
import { useAuth } from "./auth";

const MAX_LENGTH = 500;

/** Initials fallback when Google gave us no avatar. */
function Avatar({ name, src }: { name: string; src: string | null }) {
  if (src) {
    return <img className="talk-avatar" src={src} alt="" loading="lazy" />;
  }
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <div className="talk-avatar talk-avatar-fallback" aria-hidden="true">
      {initials || "?"}
    </div>
  );
}

function ReactionBar({
  post,
  onChange,
}: {
  post: Post;
  onChange: (patch: Partial<Post>) => void;
}) {
  const { user, signIn } = useAuth();
  const [error, setError] = useState(false);

  async function toggle(emoji: string) {
    if (!user) {
      signIn();
      return;
    }

    const mine = post.viewer_reactions.includes(emoji);
    const count = post.reactions[emoji] ?? 0;
    const before = { reactions: post.reactions, viewer_reactions: post.viewer_reactions };

    // Optimistic: a reaction that waits on a round trip feels broken, and on a
    // sleeping free instance that round trip can be a full minute.
    const reactions = { ...post.reactions };
    if (mine) {
      if (count <= 1) delete reactions[emoji];
      else reactions[emoji] = count - 1;
    } else {
      reactions[emoji] = count + 1;
    }
    onChange({
      reactions,
      viewer_reactions: mine
        ? post.viewer_reactions.filter((e) => e !== emoji)
        : [...post.viewer_reactions, emoji],
    });
    setError(false);

    try {
      const result = await react(post.id, emoji);
      // Reconcile against the server: someone else may have reacted in the
      // meantime, so the optimistic count is a guess, not the truth.
      onChange({
        reactions: result.reactions,
        viewer_reactions: result.viewer_reactions,
      });
    } catch {
      onChange(before);
      setError(true);
    }
  }

  return (
    <div className="talk-reactions">
      {REACTIONS.map((emoji) => {
        const count = post.reactions[emoji] ?? 0;
        const mine = post.viewer_reactions.includes(emoji);
        return (
          <button
            key={emoji}
            type="button"
            className={`talk-reaction${mine ? " is-mine" : ""}${count ? "" : " is-empty"}`}
            onClick={() => toggle(emoji)}
            aria-pressed={mine}
            aria-label={`${emoji} ${count}${mine ? ", yours" : ""}`}
            title={user ? undefined : "Sign in to react"}
          >
            <span aria-hidden="true">{emoji}</span>
            {count > 0 && <span className="talk-reaction-count">{count}</span>}
          </button>
        );
      })}
      {error && <span className="talk-inline-error">Couldn’t save that</span>}
    </div>
  );
}

function ReplyForm({
  postId,
  onAdded,
}: {
  postId: number;
  onAdded: (reply: Post) => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || busy) return;

    setBusy(true);
    setError(null);
    try {
      onAdded(await createReply(postId, body.trim()));
      setBody("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn’t post that reply");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="talk-reply-form" onSubmit={submit}>
      <input
        className="talk-reply-input"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a reply"
        maxLength={MAX_LENGTH}
        aria-label="Write a reply"
      />
      <button className="talk-btn" type="submit" disabled={!body.trim() || busy}>
        {busy ? "Posting…" : "Reply"}
      </button>
      {error && <p className="talk-inline-error">{error}</p>}
    </form>
  );
}

export function PostCard({
  post,
  onChange,
  onRemoved,
}: {
  post: Post;
  onChange: (patch: Partial<Post>) => void;
  onRemoved: () => void;
}) {
  const { user, signIn } = useAuth();
  const [replies, setReplies] = useState<Post[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loadingReplies, setLoadingReplies] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = user?.id === post.author.id;

  async function toggleReplies() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);

    // Replies load on demand and stay loaded — fetching them with the feed
    // would multiply the payload for threads nobody opens.
    if (replies === null) {
      setLoadingReplies(true);
      try {
        setReplies(await fetchReplies(post.id));
      } catch {
        setError("Couldn’t load replies");
      } finally {
        setLoadingReplies(false);
      }
    }
  }

  async function remove() {
    setError(null);
    try {
      await deletePost(post.id);
      onRemoved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn’t delete that");
    }
  }

  function addReply(reply: Post) {
    setReplies((current) => [...(current ?? []), reply]);
    onChange({ reply_count: post.reply_count + 1 });
  }

  return (
    <li className="talk-post">
      <Avatar name={post.author.display_name} src={post.author.avatar_url} />

      <div className="talk-post-body">
        <div className="talk-post-head">
          <span className="talk-author">{post.author.display_name}</span>
          <span className="meta">{relativeTime(post.created_at)}</span>
          {mine && !post.deleted && (
            <button
              type="button"
              className="talk-delete"
              onClick={remove}
              aria-label="Delete your post"
            >
              Delete
            </button>
          )}
        </div>

        {post.deleted ? (
          <p className="talk-text talk-deleted">This post was deleted.</p>
        ) : (
          <p className="talk-text">{post.body}</p>
        )}

        <div className="talk-post-actions">
          {!post.deleted && <ReactionBar post={post} onChange={onChange} />}
          {(post.reply_count > 0 || !post.deleted) && (
            <button type="button" className="talk-link" onClick={toggleReplies}>
              {post.reply_count > 0
                ? `${post.reply_count} ${post.reply_count === 1 ? "reply" : "replies"}`
                : "Reply"}
            </button>
          )}
        </div>

        {error && <p className="talk-inline-error">{error}</p>}

        {open && (
          <div className="talk-thread">
            {loadingReplies && <p className="meta">Loading replies…</p>}

            {replies?.map((reply) => (
              <div className="talk-reply" key={reply.id}>
                <Avatar name={reply.author.display_name} src={reply.author.avatar_url} />
                <div>
                  <div className="talk-post-head">
                    <span className="talk-author">{reply.author.display_name}</span>
                    <span className="meta">{relativeTime(reply.created_at)}</span>
                  </div>
                  <p className="talk-text">{reply.body}</p>
                </div>
              </div>
            ))}

            {!post.deleted &&
              (user ? (
                <ReplyForm postId={post.id} onAdded={addReply} />
              ) : (
                <button type="button" className="talk-link" onClick={signIn}>
                  Sign in to reply
                </button>
              ))}
          </div>
        )}
      </div>
    </li>
  );
}
