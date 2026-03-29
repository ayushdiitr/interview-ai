const { createSqliteStore } = require('./store-sqlite');
const { createPgStore } = require('./store-pg');

async function createStore() {
    const url = process.env.DATABASE_URL;
    if (url && url.trim()) {
        console.log('[auth-api] Using PostgreSQL');
        return createPgStore(url.trim());
    }
    console.log('[auth-api] Using SQLite (set DATABASE_URL for PostgreSQL)');
    return createSqliteStore();
}

module.exports = { createStore };
