const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashRefreshToken(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateRefreshToken() {
    return crypto.randomBytes(32).toString('hex');
}

function signAccessToken(payload, jwtSecret) {
    return jwt.sign(
        {
            sub: payload.sub,
            email: payload.email,
        },
        jwtSecret,
        { expiresIn: ACCESS_TTL_SEC }
    );
}

function verifyAccessToken(token, jwtSecret) {
    return jwt.verify(token, jwtSecret);
}

function computeAllowed(user) {
    if (!user || user.disabled) {
        return { allowed: false, reason: 'Your account has been disabled. Contact support if this is a mistake.' };
    }

    const now = Date.now();
    const status = user.subscription_status;
    const trialEnd = user.trial_ends_at ? new Date(user.trial_ends_at).getTime() : null;
    const periodEnd = user.current_period_end ? new Date(user.current_period_end).getTime() : null;

    if (status === 'active') {
        return { allowed: true, reason: null };
    }

    if (status === 'trialing') {
        if (trialEnd == null || Number.isNaN(trialEnd) || trialEnd > now) {
            return { allowed: true, reason: null };
        }
        return { allowed: false, reason: 'Your trial has ended. Please subscribe to continue.' };
    }

    if (status === 'past_due') {
        if (periodEnd != null && !Number.isNaN(periodEnd) && periodEnd > now) {
            return { allowed: true, reason: null };
        }
        return { allowed: false, reason: 'Your subscription is past due. Please update billing.' };
    }

    if (status === 'canceled') {
        if (periodEnd != null && !Number.isNaN(periodEnd) && periodEnd > now) {
            return { allowed: true, reason: null };
        }
        return { allowed: false, reason: 'Your subscription has ended.' };
    }

    return { allowed: false, reason: 'No active subscription.' };
}

function publicUserRow(row) {
    return {
        id: row.id,
        email: row.email,
        plan: row.plan,
        subscriptionStatus: row.subscription_status,
        trialEndsAt: row.trial_ends_at,
        currentPeriodEnd: row.current_period_end,
        disabled: !!row.disabled,
    };
}

function toSessionResponse(userRow) {
    const u = publicUserRow(userRow);
    const { allowed, reason } = computeAllowed(userRow);
    return {
        allowed,
        reason,
        user: u,
        plan: u.plan,
        subscriptionStatus: u.subscriptionStatus,
    };
}

module.exports = {
    ACCESS_TTL_SEC,
    REFRESH_TTL_MS,
    hashRefreshToken,
    generateRefreshToken,
    signAccessToken,
    verifyAccessToken,
    computeAllowed,
    publicUserRow,
    toSessionResponse,
};
