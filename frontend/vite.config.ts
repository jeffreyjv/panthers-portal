import { readFileSync } from "node:fs";
import { Plugin, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** How many of the fixture's scores are held back at startup, and how often one
 *  is released. The interval matches the client's own poll while a game is in
 *  progress, so each release surfaces on the next request. */
const DRIP_SCORES = 3;
const DRIP_EVERY = 20_000;

/** Hand back the fixture as it looked partway through the game.
 *
 * A score toast fires on a play the client hasn't seen before, which a static
 * fixture can never produce — the first response is the baseline and every one
 * after it is identical. Withholding the last few scores and releasing them on
 * a timer is what makes that path reachable in dev. The board is rewound to
 * match; the linescore and drive chart are left alone, since they aren't what
 * this is for.
 */
function dripScores(game: any, since: number): any {
  const plays = game.scoring_plays ?? [];
  const held = Math.max(
    0,
    Math.min(plays.length, DRIP_SCORES - Math.floor((Date.now() - since) / DRIP_EVERY)),
  );
  if (held === 0) return game;

  const released = plays.slice(0, plays.length - held);
  const last = released[released.length - 1];
  return {
    ...game,
    scoring_plays: released,
    panthers: { ...game.panthers, score: last?.panthers_score ?? 0 },
    opponent: { ...game.opponent, score: last?.opponent_score ?? 0 },
  };
}

/** Serves a canned in-progress game at /api/live, for LIVE_FIXTURE=1 npm run dev.
 *
 * The Live tab's charts — win probability, the stat bars, the drive chart —
 * only exist while a game is in the "in" state, which is a few hours a week in
 * season and never in the off-season. Without this there's no way to look at
 * them at all, let alone check them at phone width.
 *
 * `apply: "serve"` keeps it out of the production build entirely.
 */
function liveFixture(): Plugin {
  return {
    name: "live-fixture",
    apply: "serve",
    configureServer(server) {
      if (process.env.LIVE_FIXTURE !== "1") return;
      server.config.logger.info("  ➜  Live:    serving live-fixture.json at /api/live");
      // Measured from server start, so a restart replays the closing scores.
      const startedAt = Date.now();
      server.middlewares.use("/api/live", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        // Read per request so edits to the fixture show up on refresh.
        const game = JSON.parse(
          readFileSync(new URL("./live-fixture.json", import.meta.url), "utf8"),
        );
        res.end(JSON.stringify(dripScores(game, startedAt)));
      });
    },
  };
}

// Dev proxy: /api routes hit the FastAPI backend on :8000.
export default defineConfig({
  plugins: [react(), liveFixture()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
