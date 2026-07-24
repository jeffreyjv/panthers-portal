# Panthers Portal

A barebones Carolina Panthers news web app. FastAPI backend that merges the
official [Panthers RSS feed](https://www.panthers.com/rss/news) with ESPN's
Panthers news feed through an in-memory cache, and a React + Vite + TypeScript
frontend that renders it.

```
backend/    FastAPI service (RSS -> normalized Article, read-through cache)
frontend/   React single-page reader
```

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
- `GET /api/health` — status plus cache age in seconds.

### Config (environment variables)

| Variable             | Default                              | Purpose                          |
| -------------------- | ------------------------------------ | -------------------------------- |
| `PANTHERS_FEED_URL`  | `https://www.panthers.com/rss/news`  | Source RSS feed.                 |
| `ESPN_NEWS_LIMIT`    | `50`                                 | ESPN items to merge into the feed.|
| `CACHE_TTL_SECONDS`  | `600`                                | How long cached data stays fresh.|
| `FRONTEND_ORIGINS`   | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated CORS origins. |

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

## Frontend

Requires Node 18+.

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend
on port 8000, so start the backend first.

## Notes

No Docker, no CI, no tests, no auth — intentionally minimal. Adding another
news source means adding a `fetch_*` function and its adapter in
`backend/sources.py`, then listing it in `get_articles()` in `backend/main.py`.
If its pages need a different body extractor, add a branch to
`fetch_article_body()` and give the adapter a `content_url`.

Tweets are not included: X removed free read access, and ESPN's public
endpoints carry no social content — the only `x.com` references in their
payloads are links inside article prose.
