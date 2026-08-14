import { useSyncExternalStore } from "react";
// Type-only: the runtime edge goes the other way, from the toast store to here.
import type { ScoreToast } from "./toastStore";

/** System notifications for scores, while the tab is open but not looked at.
 *
 * This is not web push: there is no subscription, no server, and nothing fires
 * when the site is closed. It covers the case that actually happens on a
 * Sunday — the portal open in a background tab or on a second screen while the
 * game is on — by promoting the toast that was going to fire anyway into a
 * notification the OS will show.
 *
 * Permission is only ever requested from a button. An unprompted permission
 * dialog on page load is the single most disliked thing a site can do, and
 * Chrome now penalizes it besides.
 */

export type NotifyState = "unsupported" | "default" | "granted" | "denied" | "off";

// Permission is one-way — a browser gives no way to hand it back — so the
// "on/off" a user actually wants lives here instead.
const MUTED_KEY = "panthers-portal-notify-muted";

const supported = () => typeof window !== "undefined" && "Notification" in window;

const muted = () => localStorage.getItem(MUTED_KEY) === "1";

function read(): NotifyState {
  if (!supported()) return "unsupported";
  const permission = Notification.permission;
  if (permission === "granted") return muted() ? "off" : "granted";
  return permission === "denied" ? "denied" : "default";
}

let state: NotifyState = read();
const listeners = new Set<() => void>();

function refresh() {
  state = read();
  listeners.forEach((fn) => fn());
}

/** Ask, or — once granted — toggle. */
export async function toggleNotifications() {
  if (!supported()) return;

  if (Notification.permission === "granted") {
    localStorage.setItem(MUTED_KEY, muted() ? "0" : "1");
    refresh();
    return;
  }

  if (Notification.permission === "denied") return;

  try {
    await Notification.requestPermission();
    localStorage.setItem(MUTED_KEY, "0");
  } finally {
    refresh();
  }
}

/** Raise one score as a system notification.
 *
 * Skipped while the tab is visible: the toast is already on screen there, and
 * two notices for one touchdown is one too many. The play id doubles as the
 * tag, so a re-poll can't announce the same score twice.
 */
export function notifyScore(toast: ScoreToast) {
  if (read() !== "granted" || !document.hidden) return;

  try {
    const notification = new Notification(
      `${toast.headline} — ${toast.team}`,
      {
        body: `${toast.panthers_abbr} ${toast.panthers_score} · ${toast.opponent_abbr} ${toast.opponent_score}\n${toast.text}`,
        icon: "/icon-192.png",
        tag: toast.id,
      },
    );
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers throw here rather than resolving to "denied". Losing a
    // notification is not worth breaking the poll that produced it.
  }
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function useNotifyState(): NotifyState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
