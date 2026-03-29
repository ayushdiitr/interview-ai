# Deployment guide

End users run the **Electron** app and only need `AUTH_API_BASE` pointing at your public API (HTTPS). You operate the **auth API** and **Postgres** in the cloud; the **React admin** is static files served by the API or a CDN.

## Environment variables (production)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes (prod) | Postgres connection string, e.g. `postgres://user:pass@host:5432/dbname?sslmode=require` |
| `JWT_SECRET` | Yes | Min 32 random bytes in production |
| `ADMIN_API_KEY` | Yes | Long random string for admin API (`X-Admin-Key`) |
| `PORT` | No | Default `3847` (hosts often inject `$PORT`) |
| `TRIAL_DAYS` | No | Default `14` |
| `CORS_ORIGINS` | Optional | Comma-separated origins allowed for CORS (e.g. `https://admin.example.com`) |
| `ADMIN_STATIC_DIR` | Optional | Absolute path to built React admin (`admin-web/dist`). If unset, falls back to `server/admin/` legacy static |

Root project `.env` for Electron (build-time / local):

- `AUTH_API_BASE=https://api.yourdomain.com`

## Managed Postgres

Any provider works: **Neon**, **Supabase**, **Railway Postgres**, **Render Postgres**, **AWS RDS**, **Fly Postgres**, etc. Create a database, copy `DATABASE_URL`, enable SSL if required (`?sslmode=require`).

After first deploy, tables are created automatically from [`migrations/001_initial_pg.sql`](migrations/001_initial_pg.sql) when the server starts.

## Hosting options for the Node API

### Railway

1. New project → deploy from GitHub (this repo). Leave the service **Root Directory** empty (repo root). Railway only copies the directory you set as root into the build image; if you set it to `server`, **`admin-web` is not present** and a step like `cd ../admin-web` fails.
2. Add **PostgreSQL** plugin; Railway sets `DATABASE_URL`.
3. Set `JWT_SECRET`, `ADMIN_API_KEY` in Variables.
4. Set **`ONNXRUNTIME_NODE_INSTALL`** = **`skip`** so the root `npm ci` / install step does not run `onnxruntime-node`’s broken Linux GPU postinstall (Electron app dependency; same workaround as [`.github/workflows/build.yml`](../.github/workflows/build.yml) Linux job). The API does not need ONNX.
5. **Build command:** `cd admin-web && npm ci && npm run build && cd ../server && npm ci`
6. **Start command:** `cd server && node index.js`
7. **Optional:** set `ADMIN_STATIC_DIR` to `/app/admin-web/dist` so the API serves the built admin UI (Railway typically clones the repo at `/app`).
8. **Electron / CI:** set `AUTH_API_BASE` in the environment when running `electron-forge make` / packaging so the desktop app points at the deployed API (never embed `ADMIN_API_KEY` or `JWT_SECRET` in the client).

If you must use **Root Directory = `server`** (isolated backend context), you cannot build `admin-web` in the same service from that checkout. Use a separate Railway service with root `admin-web` for the static admin, or build `admin-web` in CI and copy `dist` into the server deploy via your own pipeline / image.

### Fly.io

1. `fly launch` in `server/` with a `Dockerfile` (Node + copy server + built `admin-web/dist`).
2. Attach Fly Postgres; `fly secrets set DATABASE_URL=...` if not auto-linked.
3. `fly secrets set JWT_SECRET=... ADMIN_API_KEY=...`

### Render

1. **Web Service** → Node, root `server`, build `npm install`, start `node index.js`.
2. **PostgreSQL** add-on; paste internal `DATABASE_URL` into web service env.
3. Add `JWT_SECRET`, `ADMIN_API_KEY`.

### Generic VPS (Docker)

- Run Postgres container + app container on a private network.
- Put **Caddy** or **nginx** in front for TLS termination to the Node port.
- Set `ADMIN_STATIC_DIR` to mount path of `admin-web/dist` if not baked into the image.

## Migrating from SQLite

1. Export users from `server/data/auth.db` (SQLite browser or `sqlite3 ... .dump`).
2. Or re-register test accounts after cutover.
3. Point production `DATABASE_URL` at Postgres; leave `DATABASE_URL` unset locally to keep using SQLite for dev.

## Electron production builds

Configure your packaging pipeline (Electron Forge env) so **`AUTH_API_BASE`** matches the deployed API URL. Do not embed `ADMIN_API_KEY` or `JWT_SECRET` in the desktop app.
