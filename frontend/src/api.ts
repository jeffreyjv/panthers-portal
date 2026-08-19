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
  /** ESPN's athlete id — joins this line to a `Player.id` on the roster. */
  athlete_id: string | null;
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
  // ESPN's event id, which the odds endpoints are keyed on. Null for byes, and
  // the backend prices exactly the games that have one.
  event_id: string | null;
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

// --- Live game ---------------------------------------------------------------
export interface LiveTeam {
  id: string;
  abbreviation: string;
  name: string;
  short_name: string;
  logo: string | null;
  score: number | null;
  record: string | null;
  /** Points per quarter, in order. Empty until the first quarter ends. */
  linescores: (number | null)[];
  panthers: boolean;
  home: boolean;
}

export interface LiveSituation {
  possession: string | null;
  down_distance: string | null;
  short_down_distance: string | null;
  spot: string | null;
  yards_to_endzone: number | null;
  last_play: string | null;
  red_zone: boolean;
  panthers_timeouts: number | null;
  opponent_timeouts: number | null;
}

export interface StatPair {
  key: string;
  label: string;
  panthers_display: string | null;
  opponent_display: string | null;
  /** What the bar length comes from; often not the number on screen. */
  panthers_value: number | null;
  opponent_value: number | null;
}

export interface ScoringPlay {
  id: string;
  period: number;
  clock: string | null;
  team_abbr: string | null;
  panthers: boolean;
  text: string;
  type_abbr: string | null;
  panthers_score: number;
  opponent_score: number;
}

export interface Drive {
  id: string;
  team_abbr: string | null;
  panthers: boolean;
  description: string | null;
  result: string | null;
  period: number | null;
  plays: number | null;
  yards: number | null;
  is_score: boolean;
  /** Yards from Carolina's own goal line: 0 is their end zone, 100 the other. */
  start_yard: number | null;
  end_yard: number | null;
  start_text: string | null;
  end_text: string | null;
  time_elapsed: string | null;
}

export interface WinProbPoint {
  /** Seconds of game clock burned, so the x-axis is time and not play count. */
  elapsed: number;
  period: number;
  panthers_pct: number;
}

export interface GameLeader {
  category: string;
  category_label: string;
  team_abbr: string | null;
  panthers: boolean;
  name: string;
  jersey: string | null;
  position: string | null;
  headshot: string | null;
  display_value: string | null;
}

export interface LiveGame {
  event_id: string;
  season: number;
  /** 1 preseason, 2 regular season, 3 postseason. */
  season_type: number;
  season_label: string | null;
  week: number | null;
  name: string | null;
  short_name: string | null;
  state: "pre" | "in" | "post";
  completed: boolean;
  status_detail: string | null;
  period: number | null;
  clock: string | null;
  kickoff: string | null;
  venue: string | null;
  venue_city: string | null;
  venue_state: string | null;
  attendance: number | null;
  broadcast: string | null;
  temperature: number | null;
  precipitation: number | null;
  line: string | null;
  over_under: number | null;
  panthers: LiveTeam;
  opponent: LiveTeam;
  situation: LiveSituation | null;
  team_stats: StatPair[];
  scoring_plays: ScoringPlay[];
  drives: Drive[];
  win_probability: WinProbPoint[];
  leaders: GameLeader[];
  fetched_at: string | null;
}

/** Quarters are 15 minutes; the win-probability axis is measured in them. */
export const QUARTER_SECONDS = 900;

/** "Q2 8:42" — where a play sits on the game clock.
 *
 * Takes the period rather than deriving it from `elapsed`, because a multiple of
 * 900 is ambiguous between the end of one quarter and the start of the next.
 */
export function periodClock(elapsed: number, period: number): string {
  const remaining = Math.max(
    0,
    QUARTER_SECONDS - (elapsed - (period - 1) * QUARTER_SECONDS),
  );
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${periodLabel(period)} ${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** "Q3", or "OT" past regulation. */
export function periodLabel(period: number): string {
  if (period <= 4) return `Q${period}`;
  return period === 5 ? "OT" : `OT${period - 4}`;
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
  /** True before Week 1, when every line has been reset to 0-0. */
  preseason: boolean;
  /** The NFC South, in standings order — alphabetical while `preseason`. */
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

/** The live game, deliberately outside `cached()`.
 *
 * That cache never invalidates, which is right for a roster and exactly wrong
 * for a score. The last response is kept here instead so returning to the tab
 * paints the previous snapshot immediately rather than a skeleton, while the
 * poll that starts on mount replaces it a moment later.
 */
let _lastLive: LiveGame | null = null;

export const peekLive = (): LiveGame | null => _lastLive;

export async function fetchLive(): Promise<LiveGame | null> {
  const game = await getJSON<LiveGame | null>("/api/live");
  _lastLive = game;
  return game;
}

/** One named game, for the recap a schedule row links to.
 *
 * Only finals are kept: they can't change again, so a second visit is free.
 * Anything still being played is left uncached and refetched, since the whole
 * problem with `cached()` is that a score would freeze at whatever it was the
 * first time the page was opened.
 */
const _games = new Map<string, LiveGame>();

export const peekGame = (eventId: string): LiveGame | undefined =>
  _games.get(eventId);

export async function fetchGame(eventId: string): Promise<LiveGame> {
  const game = await getJSON<LiveGame>(
    `/api/game/${encodeURIComponent(eventId)}`,
  );
  if (game.state === "post") _games.set(eventId, game);
  return game;
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
  /** ESPN's event id, set only on a game thread the app opened for itself.
   *  Null on everything a person wrote, and what the badge is keyed on. */
  event_id: string | null;
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

/** The thread for the game on right now, or null the rest of the year.
 *
 * Not routed through `cached()` for the same reason the feed isn't: that cache
 * never invalidates, and this changes the moment a game starts or ends.
 */
export function fetchGameThread(): Promise<Post | null> {
  return getJSON<Post | null>("/api/posts/game-thread");
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
