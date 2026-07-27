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

export interface Injury {
  id: string;
  name: string;
  position: string | null;
  headshot: string | null;
  /** "Out" | "Doubtful" | "Questionable" | "Injured Reserve" | ... */
  status: string;
  /** The body part: "Knee", "Hamstring", "Undisclosed". */
  body_part: string | null;
  /** What happened to it: "Soreness", "Surgery". Null when unspecified. */
  detail: string | null;
  return_date: string | null;
  comment: string | null;
  updated_at: string | null;
  url: string | null;
}

export interface GameLine {
  week: number;
  provider: string;
  /** The book's own phrasing, e.g. "CHI -2.5". */
  details: string | null;
  over_under: number | null;
  /** Signed from Carolina's side: "-3.5" favoured, "+2.5" getting points. */
  spread: string | null;
  money_line: number | null;
  opponent_money_line: number | null;
  favorite: boolean;
}

export interface SeasonFutures {
  provider: string;
  division: string | null;
  conference: string | null;
  super_bowl: string | null;
}

export interface Odds {
  season: number;
  futures: SeasonFutures | null;
  /** Keyed by week number. Games no book has priced are simply absent. */
  lines: Record<string, GameLine>;
}

/** American odds always carry their sign; +124 without the plus reads as 124. */
export function americanOdds(value: number | null): string | null {
  if (value === null) return null;
  return value > 0 ? `+${value}` : `${value}`;
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

export interface TeamStanding {
  team_id: string;
  name: string;
  abbreviation: string;
  logo: string | null;
  wins: number;
  losses: number;
  ties: number;
  record: string;
  win_pct: string | null;
  streak: string | null;
  points_for: number | null;
  points_against: number | null;
  division_record: string | null;
  playoff_seed: number | null;
  clinched: string | null;
  panthers: boolean;
}

export interface Standings {
  season: number;
  final: boolean;
  /** The NFC South, in standings order. */
  division: TeamStanding[];
  /** All 32 teams, keyed by abbreviation, for opponent lookups. */
  league: Record<string, TeamStanding>;
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
export const peekStandings = () => peek<Standings>("standings");
export const peekInjuries = () => peek<Injury[]>("injuries");
export const peekOdds = () => peek<Odds>("odds");
export const peekArticleContent = (id: string) =>
  peek<ArticleContent>(`content:${id}`);

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return res.json();
}

/** An error carrying the HTTP status, so callers can tell 401 from 429. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Reads the server's error detail, falling back to something sayable.
 *
 * FastAPI puts a string in `detail` for HTTPException but an array of field
 * errors there for validation failures, so a naive read renders "[object
 * Object]" at the user.
 */
async function apiError(res: Response): Promise<ApiError> {
  let detail = "";
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") {
      detail = body.detail;
    } else if (Array.isArray(body?.detail)) {
      detail = body.detail[0]?.msg ?? "";
      // Pydantic prefixes its messages; "Value error, Post cannot be empty"
      // is not a sentence to show anyone.
      detail = detail.replace(/^Value error,\s*/, "");
    }
  } catch {
    // Non-JSON body (a proxy error page, say). The status alone will do.
  }
  return new ApiError(detail || `Request failed (${res.status})`, res.status);
}

/** Writes. Deliberately not routed through `cached()` — see below. */
async function sendJSON<T>(
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    // Without this the session cookie is omitted on cross-origin dev requests
    // and every write looks like a mystery 401.
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) throw await apiError(res);
  return res.status === 204 ? (undefined as T) : res.json();
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

export function fetchStandings(): Promise<Standings> {
  return cached("standings", () => getJSON<Standings>("/api/standings"));
}

export function fetchInjuries(): Promise<Injury[]> {
  return cached("injuries", () => getJSON<Injury[]>("/api/injuries"));
}

export function fetchOdds(): Promise<Odds> {
  return cached("odds", () => getJSON<Odds>("/api/odds"));
}

// --- Talk --------------------------------------------------------------------
// Everything below bypasses `cached()` on purpose. That cache never
// invalidates, which is right for articles and rosters and wrong for a feed
// people are writing to: cached, a new post would not appear until reload.

export interface CurrentUser {
  id: number;
  display_name: string;
  avatar_url: string | null;
  email: string;
}

export interface PostAuthor {
  id: number;
  display_name: string;
  avatar_url: string | null;
}

export interface Post {
  id: number;
  parent_id: number | null;
  author: PostAuthor;
  /** Null exactly when `deleted` — a removed post keeps its place, not its text. */
  body: string | null;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  reply_count: number;
  /** emoji -> total count across everyone. */
  reactions: Record<string, number>;
  /** Which of those the viewer picked. Empty when signed out. */
  viewer_reactions: string[];
}

export interface Feed {
  posts: Post[];
  next_cursor: string | null;
}

export interface ReactionResult {
  post_id: number;
  reactions: Record<string, number>;
  viewer_reactions: string[];
}

/** The reactions the server accepts. Kept in step with ALLOWED_REACTIONS in
 *  backend/models.py — the server rejects anything else with a 422. */
export const REACTIONS = ["🔥", "😭", "👏", "🐾"] as const;

export function fetchMe(): Promise<CurrentUser | null> {
  return getJSON<CurrentUser | null>("/api/auth/me");
}

export function logout(): Promise<{ ok: boolean }> {
  return sendJSON<{ ok: boolean }>("/api/auth/logout", "POST");
}

export function fetchFeed(cursor?: string | null): Promise<Feed> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return getJSON<Feed>(`/api/posts${query}`);
}

export function createPost(body: string): Promise<Post> {
  return sendJSON<Post>("/api/posts", "POST", { body });
}

export function fetchReplies(postId: number): Promise<Post[]> {
  return getJSON<Post[]>(`/api/posts/${postId}/replies`);
}

export function createReply(postId: number, body: string): Promise<Post> {
  return sendJSON<Post>(`/api/posts/${postId}/replies`, "POST", { body });
}

export function deletePost(postId: number): Promise<void> {
  return sendJSON<void>(`/api/posts/${postId}`, "DELETE");
}

export function react(postId: number, emoji: string): Promise<ReactionResult> {
  return sendJSON<ReactionResult>(`/api/posts/${postId}/reactions`, "POST", { emoji });
}

/** Where a team sits in its division, as an ordinal: "1st", "2nd", ... */
export function divisionRank(standings: Standings): string | null {
  const index = standings.division.findIndex((t) => t.panthers);
  if (index < 0) return null;
  const place = index + 1;
  // 11th/12th/13th break the last-digit rule, hence the teens carve-out.
  const suffix =
    place % 100 >= 11 && place % 100 <= 13
      ? "th"
      : ["th", "st", "nd", "rd"][place % 10] ?? "th";
  return `${place}${suffix}`;
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
