export interface Article {
  id: string;
  title: string;
  summary: string;
  url: string;
  published_at: string | null;
  image_url: string | null;
  source: string;
  content_url: string | null;
}

/** Feed sources, mapped to how they're labelled in the UI. */
const SOURCE_LABELS: Record<string, string> = {
  "panthers.com": "Panthers",
  "espn.com": "ESPN",
};

export const sourceLabel = (source: string): string =>
  SOURCE_LABELS[source] ?? source;

export interface ArticleContent {
  id: string;
  url: string;
  paragraphs: string[];
}

export interface Player {
  id: string;
  name: string;
  jersey: string | null;
  position: string | null;
  position_name: string | null;
  group: string;
  height: string | null;
  weight: number | null;
  age: number | null;
  experience: number | null;
  college: string | null;
  headshot: string | null;
  starter: boolean;
  depth_position: string | null;
}

export interface Game {
  week: number;
  bye: boolean;
  kickoff: string | null;
  opponent: string | null;
  opponent_abbr: string | null;
  opponent_logo: string | null;
  home: boolean | null;
  venue: string | null;
  network: string | null;
  status: "scheduled" | "in_progress" | "final";
  team_score: number | null;
  opponent_score: number | null;
  outcome: "W" | "L" | "T" | null;
  url: string | null;
}

/** Per-session response cache.
 *
 * Switching tabs unmounts a view, so without this every return trip refetches
 * and replays the loading skeletons. Caching the promise (not just the result)
 * also collapses overlapping requests for the same thing. Failures are evicted
 * so they stay retryable.
 */
const _cache = new Map<string, Promise<unknown>>();
const _resolved = new Map<string, unknown>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;

  const pending = load()
    .then((value) => {
      _resolved.set(key, value);
      return value;
    })
    .catch((err) => {
      _cache.delete(key);
      throw err;
    });
  _cache.set(key, pending);
  return pending;
}

/** Synchronous read of an already-loaded response.
 *
 * Lets a view mount straight into its ready state. Waiting for the promise
 * would paint one frame of skeletons first, which is the flicker you see when
 * returning to a tab.
 */
function peek<T>(key: string): T | undefined {
  return _resolved.get(key) as T | undefined;
}

export const peekArticles = () => peek<Article[]>("articles");
export const peekSchedule = () => peek<Game[]>("schedule");
export const peekRoster = () => peek<Player[]>("roster");
export const peekArticleContent = (id: string) =>
  peek<ArticleContent>(`content:${id}`);

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return res.json();
}

export function fetchArticles(): Promise<Article[]> {
  return cached("articles", () => getJSON<Article[]>("/api/articles"));
}

export function fetchArticleContent(id: string): Promise<ArticleContent> {
  return cached(`content:${id}`, () =>
    getJSON<ArticleContent>(`/api/articles/${encodeURIComponent(id)}/content`),
  );
}

export function fetchSchedule(): Promise<Game[]> {
  return cached("schedule", () => getJSON<Game[]>("/api/schedule"));
}

export function fetchRoster(): Promise<Player[]> {
  return cached("roster", () => getJSON<Player[]>("/api/roster"));
}

// Kickoffs arrive as UTC and are rendered in the viewer's local time zone.
export function gameDate(iso: string | null): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "TBD";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function gameTime(iso: string | null): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "TBD";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Compact relative time, e.g. "3h ago", "2d ago".
export function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((Date.now() - then) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, secs] of units) {
    if (Math.abs(seconds) >= secs) {
      return rtf.format(-Math.round(seconds / secs), unit);
    }
  }
  return "just now";
}
