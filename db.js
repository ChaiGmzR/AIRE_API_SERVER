const mysql = require('mysql2/promise');
require('dotenv').config();

const pools = new Map();

function getPool(name = 'default') {
    const key = normalizePoolName(name);
    if (!pools.has(key)) {
        pools.set(key, createPool(key));
    }

    return pools.get(key);
}

async function query(sql, params = [], poolName = 'default') {
    const pool = getPool(poolName);
    const [rows] = await pool.execute(sql, params);
    return rows;
}

async function testConnection(poolName = 'default') {
    try {
        const pool = getPool(poolName);
        const connection = await pool.getConnection();
        await connection.query('SELECT 1');
        connection.release();
        return { connected: true, pool: normalizePoolName(poolName) };
    } catch (error) {
        return {
            connected: false,
            pool: normalizePoolName(poolName),
            error: error.message
        };
    }
}

async function closePools() {
    await Promise.all(Array.from(pools.values()).map(pool => pool.end()));
    pools.clear();
}

function createPool(poolName) {
    const prefix = poolName === 'default'
        ? 'DB'
        : `DB_${poolName.toUpperCase()}`;

    const config = {
        host: requiredEnv(`${prefix}_HOST`),
        port: parsePort(process.env[`${prefix}_PORT`] || process.env.DB_PORT || '3306'),
        user: requiredEnv(`${prefix}_USER`),
        password: requiredEnv(`${prefix}_PASSWORD`),
        database: requiredEnv(`${prefix}_NAME`),
        waitForConnections: true,
        connectionLimit: parsePositiveInt(process.env[`${prefix}_CONNECTION_LIMIT`] || '10'),
        queueLimit: 0,
        connectTimeout: parsePositiveInt(process.env[`${prefix}_CONNECT_TIMEOUT`] || '30000')
    };

    if ((process.env[`${prefix}_SSL`] || process.env.DB_SSL || 'true') !== 'false') {
        config.ssl = {
            rejectUnauthorized: (process.env[`${prefix}_SSL_REJECT_UNAUTHORIZED`] ||
                process.env.DB_SSL_REJECT_UNAUTHORIZED ||
                'false') === 'true'
        };
    }

    return mysql.createPool(config);
}

function requiredEnv(name) {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        throw new Error(`Missing required environment variable ${name}`);
    }

    return value;
}

function parsePort(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid database port: ${value}`);
    }

    return parsed;
}

function parsePositiveInt(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid positive integer: ${value}`);
    }

    return parsed;
}

function normalizePoolName(name) {
    return String(name || 'default').trim().toLowerCase();
}

module.exports = {
    getPool,
    query,
    testConnection,
    closePools
};
