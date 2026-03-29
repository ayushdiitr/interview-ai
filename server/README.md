# Cheating-Dev auth API

Local service that backs desktop login, registration, subscription checks, and the bundled admin UI.

## Setup

```bash
cd server
cp .env.example .env
# Edit .env: set JWT_SECRET and ADMIN_API_KEY
npm install
npm start
```

Default port **3847**. Health check: `GET /health`.

## Electron app

In the **repository root** `.env` (same file loaded by the desktop app), set the API URL if not local:

```bash
AUTH_API_BASE=http://127.0.0.1:3847
```

## API reference

See [API.md](./API.md).

## Admin UI

With the server running, open:

`http://127.0.0.1:3847/admin/`

Paste `ADMIN_API_KEY` from `.env`, click **Remember key**, then **Load users**.

## Production notes

- Terminate TLS at your reverse proxy; set strong `JWT_SECRET` and `ADMIN_API_KEY`.
- Back up `server/data/auth.db`.
- Stripe webhooks are not implemented here; update user rows via admin UI or your own integration.
