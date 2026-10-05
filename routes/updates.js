const express = require('express');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { pipeline } = require('stream/promises');
const {
    connectUpdateShare,
    getLatestInstaller,
    installerPath,
    validateVersion
} = require('../update_share');

const router = express.Router();

router.get('/latest', async (req, res) => {
    try {
        const latest = await getLatestInstaller();
        res.json({
            available: true,
            source: 'network-share',
            ...latest
        });
    } catch (error) {
        console.error('Error consultando el recurso de actualizaciones:', error.message);
        res.status(503).json({
            available: false,
            error: 'El recurso de actualizaciones no esta disponible'
        });
    }
});

router.get('/download/:version', async (req, res) => {
    const version = String(req.params.version || '').trim();
    if (!validateVersion(version)) {
        return res.status(400).json({ error: 'Version de actualizacion invalida' });
    }

    let share = null;
    try {
        share = await connectUpdateShare();
        const filePath = installerPath(version);
        const stats = await fsPromises.stat(filePath);

        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
        res.setHeader('Content-Length', stats.size);
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="AIRE_Setup_${version}.exe"`
        );

        await pipeline(fs.createReadStream(filePath), res);
    } catch (error) {
        console.error('Error descargando el instalador de actualizacion:', error.message);
        if (!res.headersSent) {
            res.status(error.code === 'ENOENT' ? 404 : 503).json({
                error: error.code === 'ENOENT'
                    ? 'El instalador solicitado no existe'
                    : 'No se pudo descargar el instalador'
            });
        } else {
            res.destroy(error);
        }
    } finally {
        if (share) {
            await share.close();
        }
    }
});

module.exports = router;
