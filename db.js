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

async function withTransaction(callback, poolName = 'default') {
    const connection = await getPool(poolName).getConnection();

    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (_) {
            // Preserve the original transaction error.
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function ensureBoxingRegistryTables() {
    const pool = getPool();

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS aire_box_registry (
            box_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            part_number VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            production_type VARCHAR(32) NOT NULL,
            line_code VARCHAR(8) NOT NULL,
            file_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            row_count INT UNSIGNED NOT NULL,
            status VARCHAR(16) NOT NULL,
            registered_at DATETIME(6) NOT NULL,
            PRIMARY KEY (box_code),
            UNIQUE KEY uq_aire_box_file_name (file_name),
            KEY idx_aire_box_registered_at (registered_at)
        ) ENGINE=InnoDB
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS aire_piece_registry (
            barcode VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            box_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            part_number VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            production_type VARCHAR(32) NOT NULL,
            line_code VARCHAR(8) NOT NULL,
            scanned_at DATETIME(6) NOT NULL,
            registered_at DATETIME(6) NOT NULL,
            PRIMARY KEY (barcode),
            KEY idx_aire_piece_box_code (box_code),
            KEY idx_aire_piece_part_registered (part_number, registered_at)
        ) ENGINE=InnoDB
    `);
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
    withTransaction,
    ensureBoxingRegistryTables,
    testConnection,
    closePools
};
