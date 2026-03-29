const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

function createSqliteStore() {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = new Database(path.join(dataDir, 'auth.db'));
    db.pragma('foreign_keys = ON');

    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      subscription_status TEXT NOT NULL DEFAULT 'trialing',
      trial_ends_at TEXT,
      current_period_end TEXT,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
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
    const insertUser = db.prepare(`
    INSERT INTO users (email, password_hash, plan, subscription_status, trial_ends_at, current_period_end)
    VALUES (?, ?, 'free', 'trialing', ?, NULL)
  `);

    return {
        driver: 'sqlite',

        async findUserByEmail(email) {
            return selectUserByEmail.get(email) || null;
        },

        async findUserById(id) {
            return selectUserById.get(id) || null;
        },

        async createUser(email, passwordHash, trialEndsIso) {
            const info = insertUser.run(email, passwordHash, trialEndsIso);
            return selectUserById.get(info.lastInsertRowid);
        },

        async replaceRefreshTokensForUser(userId, tokenHash, expiresAtIso) {
            deleteRefreshForUser.run(userId);
            insertRefresh.run(userId, tokenHash, expiresAtIso);
        },

        async findRefreshByTokenHash(tokenHash) {
            return selectRefreshByHash.get(tokenHash) || null;
        },

        async deleteRefreshTokenById(id) {
            deleteRefreshById.run(id);
        },

        async listUsersForAdmin() {
            return db
                .prepare(
                    'SELECT id, email, plan, subscription_status, trial_ends_at, current_period_end, disabled, created_at FROM users ORDER BY id'
                )
                .all();
        },

        async updateUser(id, updates) {
            const clauses = [];
            const values = [];
            if (updates.plan != null) {
                clauses.push('plan = ?');
                values.push(String(updates.plan));
            }
            if (updates.subscription_status != null) {
                clauses.push('subscription_status = ?');
                values.push(updates.subscription_status);
            }
            if (updates.trial_ends_at !== undefined) {
                clauses.push('trial_ends_at = ?');
                values.push(updates.trial_ends_at === null ? null : String(updates.trial_ends_at));
            }
            if (updates.current_period_end !== undefined) {
                clauses.push('current_period_end = ?');
                values.push(updates.current_period_end === null ? null : String(updates.current_period_end));
            }
            if (updates.disabled !== undefined) {
                clauses.push('disabled = ?');
                values.push(updates.disabled ? 1 : 0);
            }
            if (clauses.length === 0) {
                return null;
            }
            values.push(id);
            db.prepare(`UPDATE users SET ${clauses.join(', ')} WHERE id = ?`).run(...values);
            return selectUserById.get(id) || null;
        },
    };
}

module.exports = { createSqliteStore };
