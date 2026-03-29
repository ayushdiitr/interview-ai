require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const { db } = require('./db');
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

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

function normalizeEmail(email) {
    return String(email || '')
        .trim()
        .toLowerCase();
}

function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const insertUser = db.prepare(`
  INSERT INTO users (email, password_hash, plan, subscription_status, trial_ends_at, current_period_end)
  VALUES (?, ?, 'free', 'trialing', ?, NULL)
`);

const selectUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const selectUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const deleteRefreshForUser = db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?');
const insertRefresh = db.prepare(`
  INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
  VALUES (?, ?, ?)
`);
const selectRefreshByHash = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?');
const deleteRefreshById = db.prepare('DELETE FROM refresh_tokens WHERE id = ?');

function issueTokens(userRow) {
    const accessToken = signAccessToken({ sub: userRow.id, email: userRow.email }, JWT_SECRET);
    const refreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();

    deleteRefreshForUser.run(userRow.id);
    insertRefresh.run(userRow.id, tokenHash, expiresAt);

    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC };
}

function trialEndIso() {
    const d = new Date();
    d.setDate(d.getDate() + TRIAL_DAYS);
    return d.toISOString();
}

function authBearer(req, res, next) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (!m) {
        return res.status(401).json({ error: 'Missing bearer token' });
    }
    try {
        const payload = verifyAccessToken(m[1], JWT_SECRET);
        const user = selectUserById.get(payload.sub);
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }
        req.authUser = user;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function adminAuth(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.post('/auth/register', (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!validEmail(email)) {
        return res.status(400).json({ error: 'Invalid email' });
    }
    if (!password || String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = selectUserByEmail.get(email);
    if (existing) {
        return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = bcrypt.hashSync(password, 12);
    const trialEnds = trialEndIso();

    let userRow;
    try {
        const info = insertUser.run(email, passwordHash, trialEnds);
        userRow = selectUserById.get(info.lastInsertRowid);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Registration failed' });
    }

    const tokens = issueTokens(userRow);
    const session = toSessionResponse(userRow);

    return res.status(201).json({
        ...tokens,
        user: publicUserRow(userRow),
        session,
    });
});

app.post('/auth/login', (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!validEmail(email) || !password) {
        return res.status(400).json({ error: 'Invalid email or password' });
    }

    const userRow = selectUserByEmail.get(email);
    if (!userRow || !bcrypt.compareSync(String(password), userRow.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (userRow.disabled) {
        return res.status(403).json({ error: 'Account disabled' });
    }

    const preSession = toSessionResponse(userRow);
    if (!preSession.allowed) {
        return res.status(403).json({ error: preSession.reason || 'Subscription inactive' });
    }

    const tokens = issueTokens(userRow);
    const session = toSessionResponse(userRow);

    return res.json({
        ...tokens,
        user: publicUserRow(userRow),
        session,
    });
});

app.post('/auth/refresh', (req, res) => {
    const refreshToken = req.body?.refreshToken;
    if (!refreshToken || typeof refreshToken !== 'string') {
        return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const tokenHash = hashRefreshToken(refreshToken);
    const rtRow = selectRefreshByHash.get(tokenHash);
    if (!rtRow) {
        return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const expires = new Date(rtRow.expires_at).getTime();
    if (Number.isNaN(expires) || expires < Date.now()) {
        deleteRefreshById.run(rtRow.id);
        return res.status(401).json({ error: 'Refresh token expired' });
    }

    const userRow = selectUserById.get(rtRow.user_id);
    if (!userRow) {
        return res.status(401).json({ error: 'User not found' });
    }

    deleteRefreshById.run(rtRow.id);

    const tokens = issueTokens(userRow);
    return res.json(tokens);
});

app.get('/auth/session', authBearer, (req, res) => {
    const userRow = selectUserById.get(req.authUser.id);
    if (!userRow) {
        return res.status(401).json({ error: 'User not found' });
    }
    return res.json(toSessionResponse(userRow));
});

app.get('/admin/users', adminAuth, (req, res) => {
    const rows = db.prepare('SELECT id, email, plan, subscription_status, trial_ends_at, current_period_end, disabled, created_at FROM users ORDER BY id').all();
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
});

const allowedStatuses = new Set(['active', 'trialing', 'past_due', 'canceled']);

app.patch('/admin/users/:id', adminAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid id' });
    }

    const user = selectUserById.get(id);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    const b = req.body || {};
    const updates = [];
    const values = [];

    if (b.plan != null) {
        updates.push('plan = ?');
        values.push(String(b.plan));
    }
    if (b.subscriptionStatus != null) {
        if (!allowedStatuses.has(b.subscriptionStatus)) {
            return res.status(400).json({ error: 'Invalid subscriptionStatus' });
        }
        updates.push('subscription_status = ?');
        values.push(b.subscriptionStatus);
    }
    if (b.trialEndsAt !== undefined) {
        updates.push('trial_ends_at = ?');
        values.push(b.trialEndsAt === null ? null : String(b.trialEndsAt));
    }
    if (b.currentPeriodEnd !== undefined) {
        updates.push('current_period_end = ?');
        values.push(b.currentPeriodEnd === null ? null : String(b.currentPeriodEnd));
    }
    if (b.disabled !== undefined) {
        updates.push('disabled = ?');
        values.push(b.disabled ? 1 : 0);
    }

    if (updates.length === 0) {
        return res.status(400).json({ error: 'No updates' });
    }

    values.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = selectUserById.get(id);
    res.json({ user: publicUserRow(updated) });
});

const adminStatic = path.join(__dirname, 'admin');
app.use('/admin', express.static(adminStatic));

app.get('/health', (req, res) => {
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`[auth-api] listening on http://127.0.0.1:${PORT}`);
});
