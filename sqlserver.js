const sql = require('mssql');
require('dotenv').config();

let poolPromise;

function getPool() {
    if (!poolPromise) {
        poolPromise = sql.connect({
            server: requiredEnv('MSSQL_HOST'),
            port: parsePort(process.env.MSSQL_PORT || '1433'),
            database: requiredEnv('MSSQL_DATABASE'),
            user: requiredEnv('MSSQL_USER'),
            password: requiredEnv('MSSQL_PASSWORD'),
            pool: {
                max: parsePositiveInt(process.env.MSSQL_CONNECTION_LIMIT || '10'),
                min: 0,
                idleTimeoutMillis: 30000
            },
            options: {
                encrypt: process.env.MSSQL_ENCRYPT === 'true',
                trustServerCertificate:
                    process.env.MSSQL_TRUST_SERVER_CERTIFICATE !== 'false',
                enableArithAbort: true
            },
            connectionTimeout: parsePositiveInt(
                process.env.MSSQL_CONNECT_TIMEOUT || '30000'
            ),
            requestTimeout: parsePositiveInt(
                process.env.MSSQL_REQUEST_TIMEOUT || '30000'
            )
        }).catch((error) => {
            poolPromise = undefined;
            throw error;
        });
    }

    return poolPromise;
}

async function query(queryText, params = {}) {
    const pool = await getPool();
    const request = pool.request();

    for (const [name, value] of Object.entries(params)) {
        request.input(name, sql.NVarChar(128), value);
    }

    const result = await request.query(queryText);
    return result.recordset;
}

async function testConnection() {
    try {
        const pool = await getPool();
        await pool.request().query('SELECT 1 AS connected');
        return { connected: true, pool: 'sqlserver' };
    } catch (error) {
        return {
            connected: false,
            pool: 'sqlserver',
            error: error.message
        };
    }
}

async function closePool() {
    if (!poolPromise) return;

    const pool = await poolPromise.catch(() => null);
    poolPromise = undefined;
    if (pool) {
        await pool.close();
    }
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
        throw new Error(`Invalid SQL Server port: ${value}`);
    }

    return parsed;
}

function parsePositiveInt(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid positive SQL Server setting: ${value}`);
    }

    return parsed;
}

module.exports = {
    query,
    testConnection,
    closePool
};
