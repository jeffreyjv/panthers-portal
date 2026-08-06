import { readFileSync } from "node:fs";
import { Plugin, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
      server.middlewares.use("/api/live", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        // Read per request so edits to the fixture show up on refresh.
        res.end(readFileSync(new URL("./live-fixture.json", import.meta.url)));
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
