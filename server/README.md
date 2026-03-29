# Cheating-Dev auth API

Local service that backs desktop login, registration, subscription checks, and the admin UI.

## Setup

```bash
cd server
cp .env.example .env
# Edit .env: JWT_SECRET, ADMIN_API_KEY; optionally DATABASE_URL for PostgreSQL
npm install
npm start
```

Default port **3847**. Health check: `GET /health` (response includes `db: sqlite` or `postgres`).

## Database

- **Local (default):** SQLite file at `server/data/auth.db` (no `DATABASE_URL`).
- **Production:** Set `DATABASE_URL` to a Postgres connection string. Schema is applied from [`migrations/001_initial_pg.sql`](migrations/001_initial_pg.sql) on startup.

Deployment details: [DEPLOY.md](./DEPLOY.md).

## Build React admin (optional)

The server serves the Vite production build from `../admin-web/dist` when present; otherwise it falls back to legacy static files in [`admin/`](./admin/).

```bash
cd ../admin-web
npm install
npm run build
cd ../server
npm start
```

Or from `server/`: `npm run build:admin` (requires `admin-web` deps installed once).

Local React dev server (hot reload): `cd admin-web && npm run dev` — uses `admin-web/.env.development` (`VITE_API_BASE=http://127.0.0.1:3847`).

## Electron app

In the **repository root** `.env`, set:

```bash
AUTH_API_BASE=http://127.0.0.1:3847
```

Use your production HTTPS API URL in shipped builds (Electron Forge / CI env).

## API reference

See [API.md](./API.md).

## Admin UI

- **Production:** `http://127.0.0.1:3847/admin/` (React build if `admin-web/dist` exists).
- Sign in with `ADMIN_API_KEY` from `.env` as **X-Admin-Key** (same as before).

## Production notes

- Terminate TLS at your reverse proxy; set strong `JWT_SECRET` and `ADMIN_API_KEY`.
- Back up Postgres or `server/data/auth.db` (SQLite).
- Stripe webhooks are not implemented; update users via admin UI or your own integration.
