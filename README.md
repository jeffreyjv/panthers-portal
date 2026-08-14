# Panthers Portal

**Live: https://panthers-portal.onrender.com/**

A barebones Carolina Panthers news web app. FastAPI backend that merges the
official [Panthers RSS feed](https://www.panthers.com/rss/news) with ESPN's
Panthers news feed through an in-memory cache, and a React + Vite + TypeScript
frontend that renders it. A **Talk** tab adds fan posts, replies and reactions
on top, backed by Postgres and Google sign-in.

```
backend/    FastAPI service (RSS -> normalized Article, read-through cache)
frontend/   React single-page reader
```

The news half needs no database and no account. Talk needs both, and the two
are deliberately independent: if Postgres is unreachable, Talk turns itself off
and News, Schedule and Team carry on.

## Backend

Requires Python 3.10+.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r ../requirements.txt
uvicorn main:app --reload --port 8000
```

- `GET /api/articles` — list of articles, newest first.
- `GET /api/schedule` — the season calendar, bye weeks included.
- `GET /api/roster` — the roster, grouped and flagged with depth-chart starters.
- `GET /api/standings` — the NFC South table plus every team's record.
- `GET /api/live` — the game in progress, or the next one, or the last one played.
- `GET /api/game/{event_id}` — one game by ESPN event id, for a recap.
- `GET /api/health` — status plus cache age in seconds, and Talk's database state.

Talk (see [Talk](#talk) below). Reading needs no account; every write does:

- `GET /api/posts` — the feed, newest first, keyset-paginated via `cursor`.
- `POST /api/posts` — new post.
- `GET|POST /api/posts/{id}/replies` — one level of replies.
- `DELETE /api/posts/{id}` — soft delete, author only.
- `POST /api/posts/{id}/reactions` — toggle one emoji.
- `GET /api/auth/google`, `/api/auth/google/callback`, `POST /api/auth/logout`,
  `GET /api/auth/me` — Google sign-in and the current session.

### Config (environment variables)

| Variable             | Default                              | Purpose                          |
| -------------------- | ------------------------------------ | -------------------------------- |
| `PANTHERS_FEED_URL`  | `https://www.panthers.com/rss/news`  | Source RSS feed.                 |
| `ESPN_NEWS_LIMIT`    | `50`                                 | ESPN items to merge into the feed.|
| `NEWS_LIMIT`         | `50`                                 | Cap on the merged feed, applied after dedupe.|
| `CACHE_TTL_SECONDS`  | `600`                                | How long cached data stays fresh.|
| `FRONTEND_ORIGINS`   | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated CORS origins. |
| `FRONTEND_DIST`      | `../frontend/dist`                   | Built frontend to serve; ignored if absent. |

Talk adds four required settings. Without them Talk disables itself; the rest
of the app is unaffected.

| Variable                | Default | Purpose                          |
| ----------------------- | ------- | -------------------------------- |
| `DATABASE_URL`          | —       | Postgres connection string. Use the **direct** endpoint, not a pooled one. |
| `GOOGLE_CLIENT_ID`      | —       | OAuth client from the Google Cloud console. |
| `GOOGLE_CLIENT_SECRET`  | —       | Same client's secret.            |
| `APP_BASE_URL`          | —       | Origin used to build the OAuth redirect URI. |
| `SESSION_COOKIE_SECURE` | `true`  | Set `false` for local http, or the session cookie is dropped. |
| `POST_RATE_LIMIT`       | `5`     | Posts allowed per user per window.|
| `POST_RATE_WINDOW_SECONDS` | `60` | Length of that window.           |

Locally these live in `backend/.env`, which `backend/config.py` loads on import
and `.gitignore` already covers. Real environment variables always win, so a
stray `.env` can never shadow the production settings.

The cache is read-through and in-memory: fresh data is served directly; stale
data triggers a refetch. If a refetch fails, the last known good data is served
and the error is logged — an error is only returned if the cache has never been
populated.

### News sources

`/api/articles` merges two feeds, sorted newest first, each item tagged with
its `source`:

- **panthers.com** — the official RSS feed, team PR and beat coverage.
- **espn.com** — ESPN's public team news endpoint (no key). ESPN tags
  league-wide pieces with every team, so a few items are league-wide rather
  than Panthers-only; that's the same set ESPN shows on its own team page.

The two are fetched independently: if one upstream is down, the feed degrades
to the other rather than emptying, and only losing both is an error. Repeats
are dropped by URL and by normalized title, with panthers.com winning ties.

Reader body text is fetched per source. panthers.com is scraped from the
article page; ESPN bot-blocks its pages, so its story text comes from the
`content.core.api` JSON that each news item links to.

### Standings

`/api/standings` returns the NFC South in ESPN's own order — its tiebreakers
are already applied, so the order is never recomputed — alongside `league`, a
record for all 32 teams keyed by abbreviation. One request covers both, which
is what lets the schedule show each opponent's record without a second call.

ESPN publishes the coming season's table months early and then seeds it with
preseason results, so Carolina can show 1-0 weeks before Week 1. Until the
schedule confirms a regular-season game has actually been played, every line is
reset to 0-0 and the table is flagged `preseason`, which is what the strip
labels ("2026 · preseason") and what tells the schedule to drop the division
rank and the per-row opponent records — none of which mean anything yet. A
completed season is flagged `final` instead.

The Schedule tab treats standings as enrichment: if the request fails, the
division strip and the opponent records disappear and the schedule renders
exactly as it would have otherwise.

## Talk

Fan posts with one level of replies and four emoji reactions (🔥 😭 👏 🐾).
Anyone can read; posting, replying and reacting need a Google account.

Four tables, created on startup from `backend/schema.sql` — every statement is
idempotent, so there is no migration tool. All SQL lives in `backend/db.py`,
the way every upstream HTTP call lives in `sources.py`.

**Replies are posts with a `parent_id`**, which keeps one insert path and one
render path. The one-level rule is enforced in `db.create_post`, not the
schema. Deletion is soft: a removed post that still has replies survives as a
tombstone so the thread under it holds together, and its body is never served
again; one without replies disappears entirely.

**Sign-in is the OAuth authorization-code flow written out over `urllib`**, so
the app needs no cryptography dependency. Reading the profile from Google's
userinfo endpoint instead of decoding the `id_token` means there is no JWT
signature to verify — the token exchange is a server-to-server call
authenticated with the client secret, so a signature would be checking Google's
work against Google. Sessions are opaque random tokens in a table, not signed
cookies, so signing out actually revokes.

The session cookie is `httponly` and `SameSite=Lax`. Lax is also what makes the
app CSRF-safe without tokens: it withholds the cookie from cross-site POSTs
while still sending it on the top-level GET that returns from Google.

Guardrails, all server-side: a fixed emoji allowlist, a 500-character cap, an
in-memory per-user rate limit, and an `is_banned` flag checked on every write.
The rate limiter is per-process, which is one more reason to run a single
instance.

Setting it up needs a Postgres database and a Google OAuth client whose
**authorized redirect URI** is `<APP_BASE_URL>/api/auth/google/callback`,
matching character for character. Publish the consent screen, or only accounts
on the test-user list can sign in. Neither `openid`, `email` nor `profile` is a
sensitive scope, so publishing triggers no verification review.

### Privacy

This half of the app stores personal data — a Google subject id, email address
and display name per account — and hosts public user-generated content. Author
emails are never included in any post payload. There is no admin interface:
moderating beyond an author deleting their own post means going into the
database directly, which is fine at small scale and the first thing to build if
this ever gets real traffic.

## Frontend

Requires Node 18+.

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend
on port 8000, so start the backend first.

### URLs

`frontend/src/router.ts` is about a hundred lines over `history.pushState` and
`popstate` — the app has six screens and no nested layouts, which doesn't
justify a router dependency, and the two shared stores are hand-rolled the same
way. Paths are `/`, `/live`, `/schedule`, `/team`, `/talk`, `/article/{id}` and
`/game/{event_id}`. The older `?tab=` form still works and is rewritten to its
path on load, which is how `devices.html` drives three frames at once; the
`?auth=` marker Google's callback returns with is left in the query for
`auth.tsx` to read and strip.

Every path is answered with `index.html` by the SPA catch-all in
`backend/main.py`, so a link to a game survives a hard reload.

### Recaps

`/game/{event_id}` renders through the same `Live.tsx` and `GameCharts.tsx` as
the live tab, because a finished game is a live one that stopped changing. The
backend adapter is shared too — `_summary_to_live_game` in `backend/sources.py`
— so the win probability, drives and scoring summary written for kickoff work
on a game from October. Finished schedule rows link there instead of to ESPN.

### Installing it

`public/manifest.webmanifest` plus `public/sw.js`, registered from `main.tsx`
in production builds only — in dev the worker would sit in front of Vite's
module graph. The worker caches the app shell and the hashed `/assets` bundles
and **nothing else**: `/api` always goes to the network, because a cached score
looks exactly like a real one.

Score notifications (`notify.ts`) are not web push. There's no subscription and
no server; while the tab is open but not looked at, the toast that was going to
fire is also raised with the `Notification` API. Permission is only ever asked
for from the button on the Live tab.

**Testing sign-in is the exception**: use http://localhost:8000 (run
`npm run build` first so FastAPI has a frontend to serve). The OAuth redirect
URI points at the backend, and a session cookie set on `:8000` is never sent to
`:5173`.

### Working on the phone layout

Most of this site is read on a phone. http://localhost:5173/devices.html puts
three iframes at real phone widths (375, 393, 430) side by side, with controls to
drive all of them to the same tab and theme at once and to simulate the
home-indicator inset.

Media queries inside an iframe resolve against the iframe's width, so the
breakpoints fire exactly as they do on the device. What it can't reproduce is
everything that isn't CSS — momentum scrolling, Safari's zoom-on-focus, and a
real safe area.

Both dev files stay out of the build: `devices.html` sits outside `public/`, and
`live-fixture.json` is read by a plugin marked `apply: "serve"`.

### Seeing the Live tab out of season

The win probability, stat bar, and drive charts only render while a game is in
the `in` state. To work on them any other time:

```bash
npm run dev:live     # LIVE_FIXTURE=1, serves frontend/live-fixture.json at /api/live
```

The fixture is a third-quarter one-score game with 47 win-probability points, ten
drives and seven scoring plays — enough for every chart on the tab to have
something to draw. Edit the JSON and refresh; it's re-read per request.

## Deployment

One container serves both halves: the frontend is built and handed to FastAPI,
which serves it alongside `/api`. Same origin means the relative `fetch("/api/…")`
calls in `frontend/src/api.ts` work unchanged and CORS never comes up —
`FRONTEND_ORIGINS` only matters for the split dev setup.

```bash
docker build -t panthers-portal .
docker run --rm -p 8000:8000 panthers-portal
```

Open http://localhost:8000. `$PORT` is honoured if the host sets it.

On Render: New → Web Service → Docker runtime → free instance → health check path
`/api/health`. The news half needs no environment variables; every default
works. Talk needs the four settings above, and its Postgres should sit in the
same region as the service — a cross-country round trip is ~70ms against ~2ms,
and the feed query path makes several.

Deploying Talk also means adding `https://<render-host>/api/auth/google/callback`
to the OAuth client's authorized redirect URIs, alongside the localhost one.

Free instances sleep after ~15 minutes idle and take about a minute to wake, and
because the caches live in process memory they come back empty and refill from
the upstreams. Pinging `/api/health` every 10 minutes from a free scheduler keeps
it warm within the 750 instance-hours/month allowance. Cloud Run runs the same
image with a much shorter cold start if that becomes annoying.

The caches are per-process, so run **one** instance — replicas would each keep
their own copy rather than sharing. Talk's rate limiter is per-process too, so
replicas would multiply the limit by the replica count. Posts themselves live
in Postgres and survive restarts, sleeps and redeploys.

Watch for upstreams blocking datacenter IPs: the scrapers send a browser
User-Agent, which is treated more suspiciously from a cloud host than from a
laptop. Losing a source degrades rather than breaks (the feed falls back to the
other, and stale cache beats an error), so check after deploying that
`/api/articles` still returns both `source` values and that the reader returns
paragraphs for each.

## Notes

No CI and no test suite — intentionally minimal. Auth exists now, but only for
Talk; the news half is still anonymous and read-only. Adding another
news source means adding a `fetch_*` function and its adapter in
`backend/sources.py`, then listing it in `get_articles()` in `backend/main.py`.
If its pages need a different body extractor, add a branch to
`fetch_article_body()` and give the adapter a `content_url`.

Tweets are not included: X removed free read access, and ESPN's public
endpoints carry no social content — the only `x.com` references in their
payloads are links inside article prose.
