# Movie Studio

Movie artwork, trailer lookup and newsletter workspace — a web-app successor to the Movie Finder and Movie Newsletter desktop tools.

## Features

- Import movie lists from pasted text, TXT, CSV or selectable-text PDF
- Find posters/artwork (TMDB) and trailers (TMDB, optional YouTube)
- Review matches, pick alternatives, reorder and batch-select movies
- Build an email-ready HTML newsletter with banners and text
- Save/load JSON project backups; export CSV and artwork ZIP

## Quick start

Requires Node.js 22.13+.

```bash
npm install
cp .env.example .env   # add your TMDB_API_KEY (YOUTUBE_API_KEY optional)
npm start
```

Open http://127.0.0.1:3000. Run tests with `npm test`.

For hosted/container use set `HOST=0.0.0.0` and the platform's `PORT`. The server is built for single-user localhost use — add authentication and rate limits before exposing it publicly.

## Repository layout

| Path | Contents |
|---|---|
| `server.mjs` | Node.js server (API proxy, static files) |
| `public/` | Browser UI (`index.html`, `app.mjs`, `core.mjs`, `style.css`) |
| `test/` | Automated tests (`node --test`) |
| `docs/` | Feature map, setup guide, AI Studio prompt |
| `reference/original-desktop/` | Original Python desktop apps (Tkinter / PySide6) kept as reference for porting |

## Status

Working foundation, not a full port. MP4 downloads, browser-cookie sign-in, IMDb poster fallback and the rich-HTML header editor still live only in the desktop reference code — see `docs/FEATURE-MAP.md`.

## Secrets

Never commit `.env`. API keys are read server-side only.
