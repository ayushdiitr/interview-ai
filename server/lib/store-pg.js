const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function runMigrations(pool) {
    const sqlPath = path.join(__dirname, '..', 'migrations', '001_initial_pg.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
}

function poolSslOption(databaseUrl) {
    if (process.env.PGSSLMODE === 'disable') {
        return false;
    }
    if (/localhost|127\.0\.0\.1/.test(databaseUrl)) {
        return false;
    }
    return { rejectUnauthorized: false };
}

async function createPgStore(databaseUrl) {
    const pool = new Pool({
        connectionString: databaseUrl,
        ssl: poolSslOption(databaseUrl),
    });

    await runMigrations(pool);
    console.log('[auth-api] PostgreSQL migrations applied');

    return {
        driver: 'postgres',
        _pool: pool,

        async findUserByEmail(email) {
            const r = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
            return r.rows[0] ? normalizePgRow(r.rows[0]) : null;
        },

        async findUserById(id) {
            const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
            return r.rows[0] ? normalizePgRow(r.rows[0]) : null;
        },

        async createUser(email, passwordHash, trialEndsIso) {
            const r = await pool.query(
                `INSERT INTO users (email, password_hash, plan, subscription_status, trial_ends_at, current_period_end)
         VALUES ($1, $2, 'free', 'trialing', $3::timestamptz, NULL)
         RETURNING *`,
                [email, passwordHash, trialEndsIso]
            );
            return normalizePgRow(r.rows[0]);
        },

        async replaceRefreshTokensForUser(userId, tokenHash, expiresAtIso) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
                await client.query(
                    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3::timestamptz)',
                    [userId, tokenHash, expiresAtIso]
                );
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        },

        async findRefreshByTokenHash(tokenHash) {
            const r = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
            return r.rows[0] || null;
        },

        async deleteRefreshTokenById(id) {
            await pool.query('DELETE FROM refresh_tokens WHERE id = $1', [id]);
        },

        async listUsersForAdmin() {
            const r = await pool.query(
                'SELECT id, email, plan, subscription_status, trial_ends_at, current_period_end, disabled, created_at FROM users ORDER BY id'
            );
            return r.rows.map(normalizePgRow);
        },

        async updateUser(id, updates) {
            const clauses = [];
            const values = [];
            let n = 1;
            if (updates.plan != null) {
                clauses.push(`plan = $${n++}`);
                values.push(String(updates.plan));
            }
            if (updates.subscription_status != null) {
                clauses.push(`subscription_status = $${n++}`);
                values.push(updates.subscription_status);
            }
            if (updates.trial_ends_at !== undefined) {
                clauses.push(`trial_ends_at = $${n++}`);
                values.push(updates.trial_ends_at === null ? null : String(updates.trial_ends_at));
            }
            if (updates.current_period_end !== undefined) {
                clauses.push(`current_period_end = $${n++}`);
                values.push(updates.current_period_end === null ? null : String(updates.current_period_end));
            }
            if (updates.disabled !== undefined) {
                clauses.push(`disabled = $${n++}`);
                values.push(!!updates.disabled);
            }
            if (clauses.length === 0) {
                return null;
            }
            values.push(id);
            const r = await pool.query(`UPDATE users SET ${clauses.join(', ')} WHERE id = $${n} RETURNING *`, values);
            return r.rows[0] ? normalizePgRow(r.rows[0]) : null;
        },

        async end() {
            await pool.end();
        },
    };
}

function normalizePgRow(row) {
    if (!row) {
        return row;
    }
    const o = { ...row };
    o.disabled = !!o.disabled;
    if (o.trial_ends_at instanceof Date) {
        o.trial_ends_at = o.trial_ends_at.toISOString();
    }
    if (o.current_period_end instanceof Date) {
        o.current_period_end = o.current_period_end.toISOString();
    }
    if (o.created_at instanceof Date) {
        o.created_at = o.created_at.toISOString();
    }
    return o;
}

module.exports = { createPgStore };
