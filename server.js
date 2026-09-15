const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

ensureDependencies();

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const scansRouter = require('./routes/scans');
const packageInfo = require('./package.json');

const app = express();
const host = process.env.HOST || '0.0.0.0';
const port = parsePort(process.env.PORT, 3001);
const appVersion = process.env.APP_VERSION || packageInfo.version || '1.0.0';
const requiredClientVersion = process.env.REQUIRED_CLIENT_VERSION || appVersion;

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*'
}));
app.use(express.json());

// Routes
app.use('/api/scans', scansRouter);

// Health check endpoint
app.get('/health', async (req, res) => {
    const system = await scansRouter.getSystemStatus();
    res.json({
        status: 'ok',
        ready: system.connected,
        timestamp: new Date().toISOString(),
        dependencies: {
            share: system.share,
            database: system.database
        }
    });
});

// Readiness endpoint for process managers that want dependency checks
app.get('/ready', async (req, res) => {
    const system = await scansRouter.getSystemStatus();
    res.status(system.connected ? 200 : 503).json({
        status: system.connected ? 'ready' : 'not_ready',
        ...system
    });
});

// Version endpoint used by the Windows client at startup
app.get('/api/version', (req, res) => {
    res.json({
        name: 'Ilsan Packing System API',
        version: appVersion,
        requiredClientVersion,
        minimumClientVersion: requiredClientVersion,
        serverTime: new Date().toISOString()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Ilsan Packing System API',
        version: appVersion,
        endpoints: [
            'GET /api/version - Validate API/client version',
            'POST /api/scans - Register a pending scan using selected production line',
            'POST /api/scans/box/:boxCode/send - Generate BOX TXT file',
            'GET /api/scans/count/:partNumber - Get in-memory shift count',
            'GET /api/scans/box/:boxCode - Get pending box scans',
            'DELETE /api/scans/box/:boxCode/scan/:barcode - Delete one pending scan',
            'DELETE /api/scans/box/:boxCode - Clear pending box scans',
            'GET /api/scans/status - Get share access status',
            'GET /health - Process health check',
            'GET /ready - Dependency readiness check'
        ]
    });
});

// Start server
function startServer() {
    try {
        const server = app.listen(port, host, () => {
            console.log(`\n🚀 Ilsan Packing System API running on ${host}:${port}`);
            console.log(`   Local:   http://localhost:${port}`);
            console.log(`   Bound:   http://${host}:${port}`);

            console.log(`\n📡 API Endpoints:`);
            console.log(`   POST   /api/scans                  - Register a pending scan using selected production line`);
            console.log(`   POST   /api/scans/box/:code/send   - Generate BOX TXT file`);
            console.log(`   GET    /api/scans/count/:pn        - Get in-memory shift count`);
            console.log(`   GET    /api/scans/box/:code        - Get pending box scans`);
            console.log(`   DELETE /api/scans/box/:code/scan/:barcode - Delete one pending scan`);
            console.log(`   DELETE /api/scans/box/:code        - Clear pending box scans`);
            console.log(`   GET    /api/scans/status           - Get share access status`);
            console.log(`   GET    /health                     - Process health check`);
            console.log(`   GET    /ready                      - Dependency readiness check`);

            if (process.env.WRITE_PORT_FILE === 'true') {
                const fs = require('fs');
                const path = require('path');
                const portFile = path.join(__dirname, '.port');
                fs.writeFileSync(portFile, port.toString());
                console.log(`\n📁 Port saved to: ${portFile}`);
            }
        });

        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`Port ${port} is already in use. Set PORT to a free port.`);
            } else if (error.code === 'EACCES') {
                console.error(`Port ${port} requires elevated privileges or is blocked.`);
            } else {
                console.error('Server error:', error);
            }
            process.exit(1);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

function parsePort(value, fallback) {
    if (!value) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid PORT value: ${value}`);
    }

    return parsed;
}

startServer();

function ensureDependencies() {
    if (process.env.AUTO_INSTALL_DEPENDENCIES === 'false') {
        return;
    }

    const packageJsonPath = path.join(__dirname, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        throw new Error(`package.json not found at ${packageJsonPath}`);
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const dependencies = Object.keys(packageJson.dependencies || {});
    let invalid = findInvalidDependencies(dependencies);

    if (invalid.length === 0) {
        return;
    }

    console.log(`Installing or repairing dependencies: ${invalid.map(item => item.dependency).join(', ')}`);
    runNpmInstall(false);

    invalid = findInvalidDependencies(dependencies);
    if (invalid.length === 0) {
        return;
    }

    console.log(`Forcing dependency repair: ${invalid.map(item => item.dependency).join(', ')}`);
    runNpmInstall(true);

    invalid = findInvalidDependencies(dependencies);
    if (invalid.length > 0) {
        const details = invalid
            .map(item => `${item.dependency}: ${item.error.message}`)
            .join('; ');
        throw new Error(`Dependencies are still invalid after npm install: ${details}`);
    }
}

function findInvalidDependencies(dependencies) {
    return dependencies
        .map((dependency) => {
            try {
                verifyDependency(dependency);
                return null;
            } catch (error) {
                return { dependency, error };
            }
        })
        .filter(Boolean);
}

function verifyDependency(dependency) {
    const moduleNames = dependency === 'mysql2'
        ? ['mysql2', 'mysql2/promise']
        : [dependency];

    for (const moduleName of moduleNames) {
        const resolved = require.resolve(moduleName, { paths: [__dirname] });
        require(resolved);
    }
}

function runNpmInstall(force) {
    const npmCommand = process.platform === 'win32'
        ? process.env.ComSpec || 'cmd.exe'
        : 'npm';
    const npmArgs = process.platform === 'win32'
        ? ['/d', '/s', '/c', `npm install --omit=dev${force ? ' --force' : ''}`]
        : ['install', '--omit=dev', ...(force ? ['--force'] : [])];
    const result = spawnSync(npmCommand, npmArgs, {
        cwd: __dirname,
        stdio: 'inherit',
        env: process.env
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`npm install failed with exit code ${result.status}`);
    }
}
