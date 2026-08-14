import { useSyncExternalStore } from "react";

/** URL routing, by hand.
 *
 * Six screens and no nested layouts don't justify a router dependency, and the
 * rest of the app's shared state is already hand-rolled the same way
 * (`liveStore`, `toastStore`): a module-level value, a listener set, and
 * `useSyncExternalStore` over the top.
 *
 * The point of having URLs at all is that a game or a story can be linked to.
 * The backend's SPA catch-all already answers every path with index.html, so
 * a deep link survives a hard reload.
 */

export type Tab = "news" | "live" | "schedule" | "team" | "talk";

export type Route =
  | { name: Tab }
  | { name: "article"; id: string }
  | { name: "game"; eventId: string };

export const TABS: Tab[] = ["news", "live", "schedule", "team", "talk"];

const asTab = (value: string | null): Tab | undefined =>
  TABS.find((t) => t === value);

export function pathOf(route: Route): string {
  switch (route.name) {
    case "article":
      return `/article/${encodeURIComponent(route.id)}`;
    case "game":
      return `/game/${encodeURIComponent(route.eventId)}`;
    // News is the front page, so it owns "/" rather than "/news".
    case "news":
      return "/";
    default:
      return `/${route.name}`;
  }
}

/** Which tab lights up for a route.
 *
 * A story belongs to the feed it came from, and a finished game to the
 * schedule row it was opened from — which is also where their back links go.
 */
export function tabOf(route: Route): Tab {
  if (route.name === "article") return "news";
  if (route.name === "game") return "schedule";
  return route.name;
}

function parse(pathname: string): Route {
  const [head, next] = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (!head) return { name: "news" };
  if (head === "article" && next) {
    return { name: "article", id: decodeURIComponent(next) };
  }
  if (head === "game" && next) {
    return { name: "game", eventId: decodeURIComponent(next) };
  }
  return { name: asTab(head) ?? "news" };
}

/** Where to open on load, honouring the two query forms that predate paths.
 *
 * Google's callback returns to "/?auth=...", which would otherwise drop the
 * user on News — away from the tab they signed in to use. "?tab=" is the
 * explicit form, which is also how the device wall drives all three frames to
 * the same screen at once. Both are rewritten to their path, but the auth
 * marker itself is left in the query for `auth.tsx` to read and strip.
 */
function initial(): Route {
  const params = new URLSearchParams(window.location.search);
  const legacy = asTab(params.has("auth") ? "talk" : params.get("tab"));
  if (!legacy) return parse(window.location.pathname);

  params.delete("tab");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    pathOf({ name: legacy }) + (query ? `?${query}` : ""),
  );
  return { name: legacy };
}

let current: Route = initial();
// Entries this session put on the stack, so a back link knows whether there is
// anywhere of ours to go back to or whether it has to navigate instead.
let pushed = 0;
const listeners = new Set<() => void>();

function announce(route: Route) {
  current = route;
  for (const listener of listeners) listener();
}

window.addEventListener("popstate", () => {
  announce(parse(window.location.pathname));
});

export function navigate(route: Route, { replace = false } = {}) {
  const path = pathOf(route);
  if (path !== window.location.pathname) {
    window.history[replace ? "replaceState" : "pushState"](null, "", path);
    if (!replace) pushed += 1;
  }
  announce(route);
}

/** Back, for the in-app "← Back to …" links.
 *
 * Uses real history when we're the ones who pushed the current entry, so the
 * button and the browser's own back agree. On a cold deep link there is no
 * such entry — going back would leave the site — so it navigates instead.
 */
export function back(fallback: Route) {
  if (pushed > 0) {
    pushed -= 1;
    window.history.back();
    return;
  }
  navigate(fallback, { replace: true });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const snapshot = () => current;

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
