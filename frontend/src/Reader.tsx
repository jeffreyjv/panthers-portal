import { useEffect, useState } from "react";
import {
  Article,
  fetchArticleContent,
  peekArticleContent,
  relativeTime,
} from "./api";
import { ClawMark } from "./ClawMark";
import { back } from "./router";

type Status = "loading" | "error" | "ready";

/** Held while a linked-to story waits on the feed that describes it.
 *
 * A cold "/article/…" has no title or hero to show until the feed lands, so
 * this stands in for the whole page rather than just the body — otherwise the
 * back link would sit alone above an empty screen.
 */
export function ReaderSkeleton() {
  return (
    <article className="reader" aria-hidden="true">
      <div className="skeleton skeleton-media reader-hero" />
      <div className="skeleton skeleton-line long" />
      <div className="reader-body">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton skeleton-line long" />
        ))}
      </div>
    </article>
  );
}

export function Reader({ article }: { article: Article }) {
  const onBack = () => back({ name: "news" });
  const preloaded = peekArticleContent(article.id);
  const [paragraphs, setParagraphs] = useState<string[]>(
    preloaded?.paragraphs ?? [],
  );
  const [status, setStatus] = useState<Status>(preloaded ? "ready" : "loading");

  useEffect(() => {
    let active = true;
    window.scrollTo({ top: 0 });

    const hit = peekArticleContent(article.id);
    if (hit) {
      setParagraphs(hit.paragraphs);
      setStatus("ready");
      return;
    }

    setStatus("loading");
    setParagraphs([]);

    fetchArticleContent(article.id)
      .then((content) => {
        if (!active) return;
        setParagraphs(content.paragraphs);
        setStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [article.id]);

  // Escape returns to the feed, matching the back button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") back({ name: "news" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <article className="reader">
      <button type="button" className="back-link" onClick={onBack}>
        <span aria-hidden="true">←</span> Back to news
      </button>

      {article.image_url && (
        <img className="reader-hero" src={article.image_url} alt="" />
      )}

      <h1 className="reader-title">{article.title}</h1>
      <div className="reader-meta">
        <span className="meta">{relativeTime(article.published_at)}</span>
        <span className="meta">{article.source}</span>
      </div>

      {status === "loading" && (
        <div className="reader-body">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton skeleton-line long" />
          ))}
        </div>
      )}

      {status === "error" && (
        <div className="notice">
          <ClawMark className="notice-claw" />
          <h2>Couldn’t load this story</h2>
          <p>
            The full text isn’t available right now.{" "}
            <a href={article.url} target="_blank" rel="noreferrer">
              Read it on panthers.com
            </a>
            .
          </p>
        </div>
      )}

      {status === "ready" && (
        <>
          <div className="reader-body">
            {paragraphs.map((text, i) => (
              <p key={i}>{text}</p>
            ))}
          </div>
          <p className="reader-source">
            Originally published on{" "}
            <a href={article.url} target="_blank" rel="noreferrer">
              panthers.com
            </a>
          </p>
        </>
      )}
    </article>
  );
}
