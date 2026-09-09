const express = require('express');
const cors = require('cors');
require('dotenv').config();

const scansRouter = require('./routes/scans');

const app = express();
const host = process.env.HOST || '0.0.0.0';
const port = parsePort(process.env.PORT, 3000);

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

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Ilsan Packing System API',
        version: '1.0.0',
        endpoints: [
            'POST /api/scans - Register a pending scan',
            'POST /api/scans/box/:boxCode/send - Generate BOX TXT file',
            'GET /api/scans/count/:partNumber - Get in-memory shift count',
            'GET /api/scans/box/:boxCode - Get pending box scans',
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
            console.log(`   POST   /api/scans                  - Register a pending scan`);
            console.log(`   POST   /api/scans/box/:code/send   - Generate BOX TXT file`);
            console.log(`   GET    /api/scans/count/:pn        - Get in-memory shift count`);
            console.log(`   GET    /api/scans/box/:code        - Get pending box scans`);
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
