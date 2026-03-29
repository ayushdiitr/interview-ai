const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const REFRESH_FILE = 'auth-refresh.bin';

let accessToken = null;

function getAuthApiBaseRaw() {
    return (process.env.AUTH_API_BASE || 'http://127.0.0.1:3847').replace(/\/$/, '');
}

function getRefreshPath() {
    return path.join(app.getPath('userData'), REFRESH_FILE);
}

function saveRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || refreshToken.length < 16) {
        throw new Error('Invalid refresh token');
    }
    const filePath = getRefreshPath();
    let payload;
    if (safeStorage.isEncryptionAvailable()) {
        payload = safeStorage.encryptString(refreshToken);
    } else {
        console.warn('[auth-ipc] safeStorage encryption not available; storing refresh token in plaintext');
        payload = Buffer.from(refreshToken, 'utf8');
    }
    fs.writeFileSync(filePath, payload);
}

function loadRefreshToken() {
    const filePath = getRefreshPath();
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const buf = fs.readFileSync(filePath);
        if (safeStorage.isEncryptionAvailable()) {
            return safeStorage.decryptString(buf);
        }
        return buf.toString('utf8');
    } catch (e) {
        console.error('[auth-ipc] Failed to read refresh token:', e.message);
        return null;
    }
}

function clearRefreshFile() {
    try {
        const p = getRefreshPath();
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
        }
    } catch (e) {
        console.warn('[auth-ipc] Could not delete refresh file:', e.message);
    }
}

function clearSession() {
    accessToken = null;
    clearRefreshFile();
}

function validateCredentialsPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid request');
    }
    const email = String(payload.email || '')
        .trim()
        .toLowerCase();
    const password = String(payload.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('Invalid email');
    }
    if (password.length < 8) {
        throw new Error('Password must be at least 8 characters');
    }
    if (email.length > 254 || password.length > 500) {
        throw new Error('Input too long');
    }
    return { email, password };
}

async function readJsonResponse(res) {
    const text = await res.text();
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch {
        return { error: text.slice(0, 200) };
    }
}

async function postJson(urlPath, body) {
    const base = getAuthApiBaseRaw();
    const res = await fetch(`${base}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await readJsonResponse(res);
    return { res, data };
}

async function fetchSessionWithAccess() {
    const base = getAuthApiBaseRaw();
    const res = await fetch(`${base}/auth/session`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });
    const data = await readJsonResponse(res);
    return { res, data };
}

async function doRefreshFromDisk() {
    const rt = loadRefreshToken();
    if (!rt) {
        return false;
    }
    const { res, data } = await postJson('/auth/refresh', { refreshToken: rt });
    if (!res.ok) {
        clearSession();
        return false;
    }
    accessToken = data.accessToken;
    saveRefreshToken(data.refreshToken);
    return true;
}

function setupAuthIpcHandlers(ipcMain) {
    ipcMain.handle('auth:get-api-base', () => ({
        ok: true,
        base: getAuthApiBaseRaw(),
    }));

    ipcMain.handle('auth:login', async (_event, payload) => {
        try {
            const { email, password } = validateCredentialsPayload(payload);
            const { res, data } = await postJson('/auth/login', { email, password });
            if (!res.ok) {
                return {
                    ok: false,
                    error: data.error || res.statusText || 'Login failed',
                    status: res.status,
                };
            }
            accessToken = data.accessToken;
            saveRefreshToken(data.refreshToken);
            return { ok: true, ...data };
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Login failed';
            if (msg === 'Invalid request' || msg.includes('Invalid') || msg.includes('Password')) {
                return { ok: false, error: msg };
            }
            console.error('[auth-ipc] login network error:', e);
            return { ok: false, error: 'Unable to reach auth server. Is it running?', networkError: true };
        }
    });

    ipcMain.handle('auth:register', async (_event, payload) => {
        try {
            const { email, password } = validateCredentialsPayload(payload);
            const { res, data } = await postJson('/auth/register', { email, password });
            if (!res.ok) {
                return {
                    ok: false,
                    error: data.error || res.statusText || 'Registration failed',
                    status: res.status,
                };
            }
            accessToken = data.accessToken;
            saveRefreshToken(data.refreshToken);
            return { ok: true, ...data };
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Registration failed';
            if (msg === 'Invalid request' || msg.includes('Invalid') || msg.includes('Password')) {
                return { ok: false, error: msg };
            }
            console.error('[auth-ipc] register network error:', e);
            return { ok: false, error: 'Unable to reach auth server. Is it running?', networkError: true };
        }
    });

    ipcMain.handle('auth:logout', async () => {
        clearSession();
        return { ok: true };
    });

    ipcMain.handle('auth:session', async () => {
        try {
            const rt = loadRefreshToken();
            if (!accessToken && !rt) {
                return { ok: false, error: 'Not logged in', code: 'no_session' };
            }
            if (!accessToken && rt) {
                const warmed = await doRefreshFromDisk();
                if (!warmed) {
                    return { ok: false, error: 'Session expired', code: 'expired', status: 401 };
                }
            }
            let { res, data } = await fetchSessionWithAccess();
            if (res.status === 401 && rt) {
                const refreshed = await doRefreshFromDisk();
                if (!refreshed) {
                    return { ok: false, error: data.error || 'Session expired', code: 'expired', status: 401 };
                }
                ({ res, data } = await fetchSessionWithAccess());
            }
            if (!res.ok) {
                return {
                    ok: false,
                    error: data.error || res.statusText || 'Session check failed',
                    status: res.status,
                };
            }
            return { ok: true, session: data };
        } catch (e) {
            console.warn('[auth-ipc] session check network error:', e.message);
            return { ok: false, networkError: true, error: e instanceof Error ? e.message : 'Network error' };
        }
    });

    ipcMain.handle('auth:restore', async () => {
        try {
            const rt = loadRefreshToken();
            if (!rt) {
                return { ok: false, code: 'no_token' };
            }
            if (!accessToken) {
                const refreshed = await doRefreshFromDisk();
                if (!refreshed) {
                    return { ok: false, code: 'refresh_failed' };
                }
            }
            let { res, data } = await fetchSessionWithAccess();
            if (res.status === 401) {
                const refreshed = await doRefreshFromDisk();
                if (!refreshed) {
                    return { ok: false, code: 'refresh_failed' };
                }
                ({ res, data } = await fetchSessionWithAccess());
            }
            if (!res.ok) {
                clearSession();
                return { ok: false, error: data.error || 'Session invalid', code: 'session_invalid' };
            }
            if (!data.allowed) {
                clearSession();
                return { ok: false, reason: data.reason || 'Subscription inactive', code: 'not_allowed' };
            }
            return { ok: true, session: data };
        } catch (e) {
            console.warn('[auth-ipc] restore network error:', e.message);
            return { ok: false, networkError: true, error: e instanceof Error ? e.message : 'Network error', code: 'network' };
        }
    });
}

module.exports = { setupAuthIpcHandlers, getAuthApiBaseRaw, clearSessionForTests: clearSession };
