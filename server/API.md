# Auth API contract

Base URL: configured via `AUTH_API_BASE` (Electron) and same origin for admin UI in dev.

All JSON bodies use `application/json`. All authenticated user routes use header:

`Authorization: Bearer <access_token>`

## POST /auth/register

**Body:** `{ "email": string, "password": string }`

- `email`: normalized lowercase, valid email shape
- `password`: min 8 characters

**201 Response:**

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresIn": 900,
  "user": {
    "id": 1,
    "email": "user@example.com",
    "plan": "free",
    "subscriptionStatus": "trialing",
    "trialEndsAt": "2026-04-12T00:00:00.000Z",
    "currentPeriodEnd": null
  },
  "session": {
    "allowed": true,
    "reason": null,
    "plan": "free",
    "subscriptionStatus": "trialing"
  }
}
```

**Errors:** `400` validation, `409` email exists

## POST /auth/login

Same body as register.

**200 Response:** same shape as register (without 201).

**Errors:** `401` invalid credentials, `403` account disabled

## POST /auth/refresh

**Body:** `{ "refreshToken": string }`

**200 Response:**

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresIn": 900
}
```

**Errors:** `401` invalid or expired refresh token

## GET /auth/session

Requires `Authorization: Bearer <access_token>`

**200 Response:**

```json
{
  "allowed": true,
  "reason": null,
  "user": {
    "id": 1,
    "email": "user@example.com",
    "plan": "free",
    "subscriptionStatus": "trialing",
    "trialEndsAt": "...",
    "currentPeriodEnd": null,
    "disabled": false
  },
  "plan": "free",
  "subscriptionStatus": "trialing"
}
```

`allowed: false` when subscription does not permit access; client must sign out and show `reason` (human-readable).

**Errors:** `401` missing or invalid access token

---

## Admin (header: `X-Admin-Key: <ADMIN_API_KEY>`)

### GET /admin/users

**200:** `{ "users": [ { "id", "email", "plan", "subscriptionStatus", "trialEndsAt", "currentPeriodEnd", "disabled", "createdAt" } ] }`

### PATCH /admin/users/:id

**Body (all optional):** `plan`, `subscriptionStatus`, `trialEndsAt`, `currentPeriodEnd`, `disabled`

Types: `subscriptionStatus` is `active` | `trialing` | `past_due` | `canceled`; `trialEndsAt` / `currentPeriodEnd` ISO string or `null`; `disabled` boolean.

**200:** `{ "user": { ... } }`

**Errors:** `401` bad admin key, `404` user not found

---

## Access rules (`allowed`)

Computed server-side:

- `disabled === true` → not allowed (`reason`: account disabled)
- `subscriptionStatus === 'trialing'` → allowed if `trialEndsAt` is null or in the future
- `subscriptionStatus === 'active'` → allowed
- `subscriptionStatus === 'past_due'` → allowed if `currentPeriodEnd` is in the future (grace), else not allowed
- `subscriptionStatus === 'canceled'` → allowed until `currentPeriodEnd` if set and in future, else not allowed
- Unknown status → not allowed
