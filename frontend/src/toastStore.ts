import { useSyncExternalStore } from "react";
import { LiveGame, ScoringPlay, periodLabel } from "./api";

/** A score that landed while the page was open. */
export interface ScoreToast {
  id: string;
  /** "Touchdown", "Field goal" — the kind of score, said in words. */
  headline: string;
  /** Who scored it, and the colour to key the toast to. */
  team: string;
  logo: string | null;
  panthers: boolean;
  /** "Q3 · 8:42" */
  when: string;
  text: string;
  /** The board after the score, so the toast stands alone. */
  panthers_abbr: string;
  opponent_abbr: string;
  panthers_score: number;
  opponent_score: number;
}

/** Long enough to read three lines without having to chase it. */
const DISMISS_AFTER = 12_000;

/** Two scores inside a minute is normal football; ten stacked toasts is not.
 *  Only the newest few stay on screen. */
const MAX_VISIBLE = 3;

/** ESPN's scoringType abbreviations, spelled out. Anything unmapped falls back
 *  to the abbreviation itself rather than inventing a name for it. */
const SCORE_NAMES: Record<string, string> = {
  TD: "Touchdown",
  FG: "Field goal",
  SF: "Safety",
  PAT: "Extra point",
  EP: "Extra point",
  "2PT": "Two-point conversion",
};

let toasts: ScoreToast[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(toast: ScoreToast) {
  toasts = [...toasts, toast].slice(-MAX_VISIBLE);
  emit();
  window.setTimeout(() => dismissToast(toast.id), DISMISS_AFTER);
}

function toToast(play: ScoringPlay, game: LiveGame): ScoreToast {
  const team = play.panthers ? game.panthers : game.opponent;
  const type = play.type_abbr?.toUpperCase();
  return {
    id: play.id,
    headline: (type && (SCORE_NAMES[type] ?? type)) || "Score",
    team: team.short_name,
    logo: team.logo,
    panthers: play.panthers,
    when: [periodLabel(play.period), play.clock].filter(Boolean).join(" · "),
    text: play.text,
    panthers_abbr: game.panthers.abbreviation,
    opponent_abbr: game.opponent.abbreviation,
    panthers_score: play.panthers_score,
    opponent_score: play.opponent_score,
  };
}

/** Which plays have already been accounted for, and for which game. */
let seenEvent: string | null = null;
let seen = new Set<string>();

/** Turn whatever is new in a fresh snapshot into toasts.
 *
 * Called by the live store on every poll, because that's the one place that
 * knows a snapshot is new — a component diffing renders would also fire on
 * mounts and tab switches that carry no new football.
 */
export function announceScores(game: LiveGame | null) {
  if (!game) {
    seenEvent = null;
    seen = new Set();
    return;
  }

  const firstLook = game.event_id !== seenEvent;
  if (firstLook) {
    seenEvent = game.event_id;
    seen = new Set();
  }

  const unseen = game.scoring_plays.filter((play) => !seen.has(play.id));
  game.scoring_plays.forEach((play) => seen.add(play.id));

  // The first snapshot of a game only sets the baseline: opening the site at
  // halftime shouldn't fire a toast for every score already on the board. And a
  // finished game is a box score, not news.
  if (firstLook || game.state !== "in") return;

  unseen.forEach((play) => push(toToast(play, game)));
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useScoreToasts(): ScoreToast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}
