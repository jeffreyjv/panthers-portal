import { MouseEvent, useEffect, useState } from "react";
import {
  Article,
  fetchArticles,
  peekArticles,
  relativeTime,
  sourceLabel,
} from "./api";
import { ClawMark } from "./ClawMark";
import { Reader, ReaderSkeleton } from "./Reader";
import { navigate, pathOf, useRoute } from "./router";

type Status = "loading" | "error" | "ready";

/** Every card is a real link to the story's own URL.
 *
 * Plain clicks are routed in-app so nothing reloads; modified clicks are left
 * alone, which now opens the reader in a new tab rather than jumping straight
 * to the source. The source is still one link away at the foot of the reader,
 * and in exchange "copy link address" yields something shareable.
 */
function openInReader(e: MouseEvent, article: Article) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  navigate({ name: "article", id: article.id });
}

const articlePath = (article: Article) =>
  pathOf({ name: "article", id: article.id });

function backToNews(e: MouseEvent) {
  e.preventDefault();
  navigate({ name: "news" });
}

function Thumb({ src, className }: { src: string | null; className: string }) {
  if (src) {
    return <img className={className} src={src} alt="" loading="lazy" />;
  }
  return (
    <div className={`${className} thumb-fallback`}>
      <ClawMark className="thumb-fallback-claw" />
    </div>
  );
}

/** Footer line on every card: who filed it, and how long ago. */
function Byline({ article }: { article: Article }) {
  const time = relativeTime(article.published_at);
  // "panthers.com" -> "panthers", so each source can be tinted separately.
  const slug = article.source.split(".")[0];
  return (
    <span className="meta byline">
      <span className={`source source-${slug}`}>
        {sourceLabel(article.source)}
      </span>
      {time && <span>{time}</span>}
    </span>
  );
}

function FeatureCard({ article }: { article: Article }) {
  return (
    <a
      className="feature"
      href={articlePath(article)}
      onClick={(e) => openInReader(e, article)}
    >
      <Thumb src={article.image_url} className="feature-media" />
      <div className="feature-scrim" />
      <div className="feature-body">
        <span className="tag">Top Story</span>
        <h2 className="feature-title">{article.title}</h2>
        {article.summary && (
          <p className="feature-summary">{article.summary}</p>
        )}
        <Byline article={article} />
      </div>
    </a>
  );
}

function StoryCard({ article }: { article: Article }) {
  return (
    <li>
      <a
        className="card"
        href={articlePath(article)}
        onClick={(e) => openInReader(e, article)}
      >
        <div className="card-media-wrap">
          <Thumb src={article.image_url} className="card-media" />
        </div>
        <div className="card-body">
          <h3 className="card-title">{article.title}</h3>
          {article.summary && <p className="card-summary">{article.summary}</p>}
          <Byline article={article} />
        </div>
      </a>
    </li>
  );
}

function SkeletonCard() {
  return (
    <li>
      <div className="card card-skeleton">
        <div className="card-media-wrap">
          <div className="skeleton skeleton-media" />
        </div>
        <div className="card-body">
          <div className="skeleton skeleton-line long" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line short" />
        </div>
      </div>
    </li>
  );
}

export function News() {
  const preloaded = peekArticles();
  const route = useRoute();
  const [articles, setArticles] = useState<Article[]>(preloaded ?? []);
  const [status, setStatus] = useState<Status>(preloaded ? "ready" : "loading");

  useEffect(() => {
    let active = true;
    fetchArticles()
      .then((data) => {
        if (!active) return;
        setArticles(data);
        setStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, []);

  // The reader needs the card's metadata — title, image, byline — and the feed
  // is where that lives, so a link opened cold waits on the same fetch the
  // feed does rather than asking the backend for it a second way.
  if (route.name === "article") {
    const article = articles.find((a) => a.id === route.id);
    if (article) return <Reader article={article} />;
    if (status === "loading") return <ReaderSkeleton />;
    return (
      <div className="notice">
        <ClawMark className="notice-claw" />
        <h2>Story not found</h2>
        <p>
          This one has rolled off the feed.{" "}
          <a href="/" onClick={backToNews}>
            Back to news
          </a>
          .
        </p>
      </div>
    );
  }

  const [feature, ...rest] = articles;

  return (
    <>
      {status === "loading" && (
        <>
          <div className="feature feature-skeleton">
            <div className="skeleton skeleton-media" />
          </div>
          <div className="section-head">
            <h2 className="section-title">Latest News</h2>
          </div>
          <ul className="grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </ul>
        </>
      )}

      {status === "error" && (
        <div className="notice">
          <ClawMark className="notice-claw" />
          <h2>We dropped the ball</h2>
          <p>The news feed couldn’t be loaded. Please try again shortly.</p>
        </div>
      )}

      {status === "ready" && articles.length === 0 && (
        <div className="notice">
          <ClawMark className="notice-claw" />
          <h2>No news right now</h2>
          <p>Check back soon for the latest from Carolina.</p>
        </div>
      )}

      {status === "ready" && feature && (
        <>
          <FeatureCard article={feature} />
          {rest.length > 0 && (
            <>
              <div className="section-head">
                <h2 className="section-title">Latest News</h2>
                <span className="section-rule" />
              </div>
              <ul className="grid">
                {rest.map((a) => (
                  <StoryCard key={a.id} article={a} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}
