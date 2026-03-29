require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { createStore } = require('./lib/store');
const {
    ACCESS_TTL_SEC,
    REFRESH_TTL_MS,
    hashRefreshToken,
    generateRefreshToken,
    signAccessToken,
    verifyAccessToken,
    toSessionResponse,
    publicUserRow,
} = require('./auth-logic');

const PORT = Number(process.env.PORT) || 3847;
const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 14;

if (!JWT_SECRET || JWT_SECRET.length < 16) {
    console.warn('[auth-api] JWT_SECRET is missing or too short; set it in server/.env');
}

const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
          .map(s => s.trim())
          .filter(Boolean)
    : null;

function catchAsync(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function normalizeEmail(email) {
    return String(email || '')
        .trim()
        .toLowerCase();
}

function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function issueTokens(store, userRow) {
    const accessToken = signAccessToken({ sub: userRow.id, email: userRow.email }, JWT_SECRET);
    const refreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
    await store.replaceRefreshTokensForUser(userRow.id, tokenHash, expiresAt);
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC };
}

function trialEndIso() {
    const d = new Date();
    d.setDate(d.getDate() + TRIAL_DAYS);
    return d.toISOString();
}

function adminAuth(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function mountAdminAndListen(app, store) {
    const configuredDist = process.env.ADMIN_STATIC_DIR ? path.resolve(process.env.ADMIN_STATIC_DIR) : null;
    const defaultDist = path.join(__dirname, '..', 'admin-web', 'dist');
    const adminDist = configuredDist || defaultDist;
    const legacyAdmin = path.join(__dirname, 'admin');

    if (fs.existsSync(adminDist) && fs.existsSync(path.join(adminDist, 'index.html'))) {
        console.log('[auth-api] Serving React admin from', adminDist);
        app.use('/admin', express.static(adminDist));
        app.use('/admin', (req, res, next) => {
            if (req.method !== 'GET') {
                return next();
            }
            res.sendFile(path.join(adminDist, 'index.html'), err => {
                if (err) {
                    next(err);
                }
            });
        });
    } else {
        console.log('[auth-api] Serving legacy static admin from', legacyAdmin);
        app.use('/admin', express.static(legacyAdmin));
    }

    app.get('/health', (req, res) => {
        res.json({ ok: true, db: store.driver });
    });

    app.use((err, req, res, _next) => {
        console.error('[auth-api]', err);
        res.status(500).json({ error: 'Internal server error' });
    });

    app.listen(PORT, () => {
        console.log(`[auth-api] listening on http://127.0.0.1:${PORT}`);
    });
}

(async () => {
    const store = await createStore();

    const app = express();
    if (corsOrigins && corsOrigins.length > 0) {
        app.use(cors({ origin: '*', credentials: true }));
    } else {
        app.use(cors());
    }
    app.use(express.json({ limit: '32kb' }));

    function authBearer(req, res, next) {
        const h = req.headers.authorization || '';
        const m = /^Bearer\s+(.+)$/.exec(h);
        if (!m) {
            return res.status(401).json({ error: 'Missing bearer token' });
        }
        let payload;
        try {
            payload = verifyAccessToken(m[1], JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        const uid = Number(payload.sub);
        store
            .findUserById(uid)
            .then(user => {
                if (!user) {
                    return res.status(401).json({ error: 'User not found' });
                }
                req.authUser = user;
                next();
            })
            .catch(next);
    }

    app.post(
        '/auth/register',
        catchAsync(async (req, res) => {
            const email = normalizeEmail(req.body?.email);
            const password = req.body?.password;

            if (!validEmail(email)) {
                return res.status(400).json({ error: 'Invalid email' });
            }
            if (!password || String(password).length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters' });
            }

            const existing = await store.findUserByEmail(email);
            if (existing) {
                return res.status(409).json({ error: 'An account with this email already exists' });
            }

            const passwordHash = bcrypt.hashSync(password, 12);
            const trialEnds = trialEndIso();

            let userRow;
            try {
                userRow = await store.createUser(email, passwordHash, trialEnds);
            } catch (e) {
                console.error(e);
                return res.status(500).json({ error: 'Registration failed' });
            }

            const tokens = await issueTokens(store, userRow);
            const session = toSessionResponse(userRow);

            return res.status(201).json({
                ...tokens,
                user: publicUserRow(userRow),
                session,
            });
        })
    );

    app.post(
        '/auth/login',
        catchAsync(async (req, res) => {
            const email = normalizeEmail(req.body?.email);
            const password = req.body?.password;

            if (!validEmail(email) || !password) {
                return res.status(400).json({ error: 'Invalid email or password' });
            }

            const userRow = await store.findUserByEmail(email);
            const passwordOk = userRow && bcrypt.compareSync(String(password), userRow.password_hash);
            if (!passwordOk) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            if (userRow.disabled) {
                return res.status(403).json({ error: 'Account disabled' });
            }

            const preSession = toSessionResponse(userRow);
            if (!preSession.allowed) {
                return res.status(403).json({ error: preSession.reason || 'Subscription inactive' });
            }

            const tokens = await issueTokens(store, userRow);
            const session = toSessionResponse(userRow);

            return res.json({
                ...tokens,
                user: publicUserRow(userRow),
                session,
            });
        })
    );

    app.post(
        '/auth/refresh',
        catchAsync(async (req, res) => {
            const refreshToken = req.body?.refreshToken;
            if (!refreshToken || typeof refreshToken !== 'string') {
                return res.status(401).json({ error: 'Invalid refresh token' });
            }

            const tokenHash = hashRefreshToken(refreshToken);
            const rtRow = await store.findRefreshByTokenHash(tokenHash);
            if (!rtRow) {
                return res.status(401).json({ error: 'Invalid refresh token' });
            }

            const expires = new Date(rtRow.expires_at).getTime();
            if (Number.isNaN(expires) || expires < Date.now()) {
                await store.deleteRefreshTokenById(rtRow.id);
                return res.status(401).json({ error: 'Refresh token expired' });
            }

            const userRow = await store.findUserById(rtRow.user_id);
            if (!userRow) {
                return res.status(401).json({ error: 'User not found' });
            }

            await store.deleteRefreshTokenById(rtRow.id);

            const tokens = await issueTokens(store, userRow);
            return res.json(tokens);
        })
    );

    app.get(
        '/auth/session',
        authBearer,
        catchAsync(async (req, res) => {
            const userRow = await store.findUserById(req.authUser.id);
            if (!userRow) {
                return res.status(401).json({ error: 'User not found' });
            }
            return res.json(toSessionResponse(userRow));
        })
    );

    app.get(
        '/admin/users',
        adminAuth,
        catchAsync(async (req, res) => {
            const rows = await store.listUsersForAdmin();
            const users = rows.map(r => ({
                id: r.id,
                email: r.email,
                plan: r.plan,
                subscriptionStatus: r.subscription_status,
                trialEndsAt: r.trial_ends_at,
                currentPeriodEnd: r.current_period_end,
                disabled: !!r.disabled,
                createdAt: r.created_at,
            }));
            res.json({ users });
        })
    );

    const allowedStatuses = new Set(['active', 'trialing', 'past_due', 'canceled']);

    app.patch(
        '/admin/users/:id',
        adminAuth,
        catchAsync(async (req, res) => {
            const id = Number(req.params.id);
            if (!Number.isInteger(id)) {
                return res.status(400).json({ error: 'Invalid id' });
            }

            const user = await store.findUserById(id);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            const b = req.body || {};
            const patch = {};
            if (b.plan != null) {
                patch.plan = String(b.plan);
            }
            if (b.subscriptionStatus != null) {
                if (!allowedStatuses.has(b.subscriptionStatus)) {
                    return res.status(400).json({ error: 'Invalid subscriptionStatus' });
                }
                patch.subscription_status = b.subscriptionStatus;
            }
            if (b.trialEndsAt !== undefined) {
                patch.trial_ends_at = b.trialEndsAt === null ? null : String(b.trialEndsAt);
            }
            if (b.currentPeriodEnd !== undefined) {
                patch.current_period_end = b.currentPeriodEnd === null ? null : String(b.currentPeriodEnd);
            }
            if (b.disabled !== undefined) {
                patch.disabled = !!b.disabled;
            }

            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ error: 'No updates' });
            }

            const updated = await store.updateUser(id, patch);
            res.json({ user: publicUserRow(updated) });
        })
    );

    mountAdminAndListen(app, store);
})();
