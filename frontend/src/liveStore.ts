import { useSyncExternalStore } from "react";
import { LiveGame, fetchLive, peekLive } from "./api";
import { announceScores } from "./toastStore";

export type LiveStatus = "loading" | "error" | "ready";

export interface LiveSnapshot {
  game: LiveGame | null;
  status: LiveStatus;
  refreshing: boolean;
}

/** How often to ask again, in milliseconds.
 *
 * Matched to how fast the thing being watched actually moves: a live game is
 * worth seconds, a scheduled one only needs to be caught starting, and a final
 * box score is finished. The server caches on the same schedule, so polling
 * faster than this would mostly re-read its own cache anyway.
 */
function pollInterval(game: LiveGame | null): number | null {
  if (!game) return 5 * 60_000;
  if (game.state === "in") return 20_000;
  if (game.state === "post") return null;

  if (!game.kickoff) return 5 * 60_000;
  const untilKickoff = new Date(game.kickoff).getTime() - Date.now();
  return untilKickoff <= 30 * 60_000 ? 30_000 : 5 * 60_000;
}

/** One poll loop, shared.
 *
 * The masthead needs the game state on every tab — that's what animates the
 * Live tab while a game is on — and the Live tab needs the whole game. Two
 * independent pollers would double the requests for the same snapshot and let
 * the two disagree for up to an interval, so both read from here instead. The
 * loop runs only while something is subscribed.
 */
let snapshot: LiveSnapshot = {
  game: null,
  status: "loading",
  refreshing: false,
};

const listeners = new Set<() => void>();
let timer: number | undefined;
let inFlight = false;
let loadedAt = 0;

function set(next: Partial<LiveSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((fn) => fn());
}

function schedule() {
  window.clearTimeout(timer);
  if (listeners.size === 0) return;
  const wait = pollInterval(snapshot.game);
  if (wait !== null) timer = window.setTimeout(load, wait);
}

async function load() {
  if (inFlight) return;
  inFlight = true;
  // Only the very first load shows skeletons; a refetch holds the previous
  // render so the page doesn't flash between snapshots.
  if (snapshot.game) set({ refreshing: true });
  try {
    const game = await fetchLive();
    loadedAt = Date.now();
    // Before the state change, so a toast and the board it describes land in
    // the same render rather than a frame apart.
    announceScores(game);
    set({ game, status: "ready", refreshing: false });
  } catch {
    set({
      status: snapshot.status === "ready" ? "ready" : "error",
      refreshing: false,
    });
  } finally {
    inFlight = false;
    schedule();
  }
}

/** A background tab is throttled by the browser, so coming back to one that has
 *  been open since the first quarter would otherwise show a stale score for up
 *  to a full interval. */
function onVisible() {
  if (document.visibilityState === "visible") load();
}

function subscribe(fn: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(fn);

  if (first) {
    document.addEventListener("visibilitychange", onVisible);
    const preloaded = peekLive();
    if (preloaded && snapshot.game === null) {
      snapshot = { game: preloaded, status: "ready", refreshing: false };
    }
    // A remount seconds later (a StrictMode double-mount, a tab switch that
    // unmounts the last subscriber) shouldn't cost another request.
    if (snapshot.status === "ready" && Date.now() - loadedAt < 2_000) schedule();
    else load();
  }

  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

export function useLive(): LiveSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
