const express = require('express');
const { constants } = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { query, testConnection } = require('../db');
const { extractPartNumber, validateBoxId, validateBarCode } = require('../utils/partNumber');
const { getShiftTimeRange, formatDateTime } = require('../utils/shifts');

const router = express.Router();

const DEFAULT_BOX_DATA_PATH = '\\\\192.168.1.144\\lg-pws\\TDATA\\BOX\\DATA';
const BOX_DATA_PATH = process.env.BOX_DATA_PATH || DEFAULT_BOX_DATA_PATH;
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

const pendingBoxes = new Map();
const scanHistory = [];

/**
 * POST /api/scans
 * Register a pending piece scan for the active box.
 * Body: { boxCode, barcode }
 */
router.post('/', async (req, res) => {
    try {
        const { boxCode, barcode } = req.body;

        const boxValidation = validateBoxId(boxCode);
        if (!boxValidation.valid) {
            return res.status(400).json({ error: boxValidation.error });
        }

        const barcodeValidation = validateBarCode(barcode);
        if (!barcodeValidation.valid) {
            return res.status(400).json({ error: barcodeValidation.error });
        }

        const existingBoxScans = pendingBoxes.get(boxValidation.boxId) || [];
        const duplicate = existingBoxScans.some(scan => scan.serial === barcodeValidation.barcode);
        if (duplicate) {
            return res.status(409).json({ error: 'Barcode already scanned in this box' });
        }

        const partValidation = validateBoxPartNumber(existingBoxScans, barcodeValidation.partNumber);
        if (!partValidation.valid) {
            return res.status(409).json({ error: partValidation.error });
        }

        const testStatus = await validateQualityStatus(barcodeValidation.barcode);
        if (!testStatus.valid) {
            return res.status(409).json({
                error: testStatus.error,
                quality: testStatus.quality
            });
        }

        const boxScans = getOrCreateBox(boxValidation.boxId);
        const now = new Date();
        const scan = {
            id: boxScans.length + 1,
            serial: barcodeValidation.barcode,
            boxCode: boxValidation.boxId,
            partNumber: barcodeValidation.partNumber,
            firstScan: formatDateTime(now),
            scanDate: now
        };

        boxScans.push(scan);

        res.json({
            success: true,
            scan: {
                serial: scan.serial,
                boxCode: scan.boxCode,
                partNumber: scan.partNumber,
                scanTime: scan.firstScan
            },
            counts: {
                box: boxScans.length,
                shift: getShiftCount(scan.partNumber)
            }
        });
    } catch (error) {
        console.error('Error registering pending scan:', error);
        res.status(500).json({ error: 'Failed to register scan', details: error.message });
    }
});

/**
 * POST /api/scans/box/:boxCode/send
 * Write the active box scans to BOX DATA as a complete .txt file.
 */
router.post('/box/:boxCode/send', async (req, res) => {
    try {
        const { boxCode } = req.params;

        const boxValidation = validateBoxId(boxCode);
        if (!boxValidation.valid) {
            return res.status(400).json({ error: boxValidation.error });
        }

        const boxScans = pendingBoxes.get(boxValidation.boxId) || [];
        if (boxScans.length === 0) {
            return res.status(400).json({ error: 'No pending scans for this box' });
        }

        await fs.access(BOX_DATA_PATH, constants.W_OK);

        const sendDate = new Date();
        const lastScan = formatDateTime(sendDate);
        const targetPath = await getAvailableBoxFilePath(boxValidation.boxId, sendDate);
        const targetName = path.win32.basename(targetPath);
        const tempPath = `${targetPath}.writing-${process.pid}-${Date.now()}`;
        const content = buildBoxFileContent(boxScans, lastScan);

        await fs.writeFile(tempPath, content, 'ascii');
        await fs.rename(tempPath, targetPath);

        for (const scan of boxScans) {
            scanHistory.push({
                ...scan,
                lastScan,
                sentAt: sendDate
            });
        }
        pendingBoxes.delete(boxValidation.boxId);
        pruneHistory();

        res.json({
            success: true,
            boxCode: boxValidation.boxId,
            file: {
                name: targetName,
                path: targetPath,
                rows: boxScans.length,
                lastScan
            }
        });
    } catch (error) {
        console.error('Error sending box file:', error);
        res.status(500).json({ error: 'Failed to send box file', details: error.message });
    }
});

/**
 * GET /api/scans/count/:partNumber
 * Get in-memory shift count for a part number.
 */
router.get('/count/:partNumber', (req, res) => {
    try {
        const { partNumber } = req.params;
        const count = getShiftCount(partNumber);
        const shiftInfo = getShiftTimeRange();

        res.json({
            partNumber,
            count,
            shift: shiftInfo.shift,
            shiftStart: shiftInfo.startStr,
            shiftEnd: shiftInfo.endStr
        });
    } catch (error) {
        console.error('Error getting shift count:', error);
        res.status(500).json({ error: 'Failed to get count', details: error.message });
    }
});

/**
 * GET /api/scans/box/:boxCode
 * Get pending scans for a specific box.
 */
router.get('/box/:boxCode', (req, res) => {
    try {
        const { boxCode } = req.params;
        const boxScans = pendingBoxes.get(boxCode) || [];

        res.json({
            boxCode,
            count: boxScans.length,
            scans: boxScans.map(scan => ({
                id: scan.id,
                serial: scan.serial,
                boxCode: scan.boxCode,
                firstScan: scan.firstScan,
                lastScan: null,
                partNumber: extractPartNumber(scan.serial)
            }))
        });
    } catch (error) {
        console.error('Error getting pending box scans:', error);
        res.status(500).json({ error: 'Failed to get box scans', details: error.message });
    }
});

/**
 * DELETE /api/scans/box/:boxCode
 * Clear pending scans for a box.
 */
router.delete('/box/:boxCode', (req, res) => {
    try {
        const { boxCode } = req.params;
        const boxScans = pendingBoxes.get(boxCode) || [];
        const deletedCount = boxScans.length;

        pendingBoxes.delete(boxCode);

        res.json({
            success: true,
            boxCode,
            deletedCount
        });
    } catch (error) {
        console.error('Error clearing pending box scans:', error);
        res.status(500).json({ error: 'Failed to clear box scans', details: error.message });
    }
});

/**
 * GET /api/scans/status
 * Get current status (share access and shift info).
 */
router.get('/status', async (req, res) => {
    const status = await getSystemStatus();
    res.json(status);
});

function getOrCreateBox(boxCode) {
    if (!pendingBoxes.has(boxCode)) {
        pendingBoxes.set(boxCode, []);
    }
    return pendingBoxes.get(boxCode);
}

function validateBoxPartNumber(boxScans, partNumber) {
    if (boxScans.length === 0) {
        return { valid: true };
    }

    const expectedPartNumber = boxScans[0].partNumber;
    if (expectedPartNumber === partNumber) {
        return { valid: true };
    }

    return {
        valid: false,
        error: `Part number mismatch. Expected ${expectedPartNumber}, got ${partNumber}`
    };
}

async function validateQualityStatus(barcode) {
    const [ictRows, fctRows] = await Promise.all([
        query(
            `SELECT resultado, ts
             FROM history_ict
             WHERE barcode = ?
             ORDER BY ts DESC
             LIMIT 1`,
            [barcode]
        ),
        query(
            `SELECT result, COALESCE(test_ts, TIMESTAMP(fecha, hora)) AS test_ts
             FROM history_fct
             WHERE barcode = ?
             ORDER BY COALESCE(test_ts, TIMESTAMP(fecha, hora)) DESC
             LIMIT 1`,
            [barcode]
        )
    ]);

    const ict = ictRows[0] || null;
    const fct = fctRows[0] || null;
    const quality = {
        ict: {
            found: Boolean(ict),
            status: ict?.resultado || null,
            timestamp: ict?.ts || null
        },
        fct: {
            found: Boolean(fct),
            status: fct?.result || null,
            timestamp: fct?.test_ts || null
        }
    };

    if (!ict) {
        return { valid: false, error: 'ICT status not found for this barcode', quality };
    }

    if (normalizeStatus(ict.resultado) !== 'OK') {
        return { valid: false, error: `ICT status must be OK. Current status: ${ict.resultado}`, quality };
    }

    if (!fct) {
        return { valid: false, error: 'FCT status not found for this barcode', quality };
    }

    if (normalizeStatus(fct.result) !== 'OK') {
        return { valid: false, error: `FCT status must be OK. Current status: ${fct.result}`, quality };
    }

    return { valid: true, quality };
}

function normalizeStatus(value) {
    return String(value || '').trim().toUpperCase();
}

function buildBoxFileContent(scans, lastScan) {
    return scans
        .slice()
        .reverse()
        .map(scan => `${scan.serial}|${scan.boxCode}|${scan.firstScan}|${lastScan}`)
        .join('\r\n') + '\r\n';
}

async function getAvailableBoxFilePath(boxCode, date) {
    for (let offsetSeconds = 0; offsetSeconds < 60; offsetSeconds++) {
        const candidateDate = new Date(date.getTime() + offsetSeconds * 1000);
        const fileName = `${boxCode}_${formatFileTimestamp(candidateDate)}.txt`;
        const filePath = path.win32.join(BOX_DATA_PATH, fileName);

        if (!(await pathExists(filePath))) {
            return filePath;
        }
    }

    throw new Error('Could not allocate a unique BOX file name');
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (_) {
        return false;
    }
}

function formatFileTimestamp(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function getShiftCount(partNumber) {
    const shiftInfo = getShiftTimeRange();
    pruneHistory();

    return getAllKnownScans()
        .filter(scan =>
            scan.partNumber === partNumber &&
            scan.scanDate >= shiftInfo.startDate &&
            scan.scanDate < shiftInfo.endDate
        )
        .length;
}

function getAllKnownScans() {
    const pending = Array.from(pendingBoxes.values()).flat();
    return pending.concat(scanHistory);
}

function pruneHistory() {
    const cutoff = Date.now() - HISTORY_RETENTION_MS;

    for (let i = scanHistory.length - 1; i >= 0; i--) {
        if (scanHistory[i].scanDate.getTime() < cutoff) {
            scanHistory.splice(i, 1);
        }
    }
}

async function getSystemStatus() {
    const shiftInfo = getShiftTimeRange();
    const [share, database] = await Promise.all([
        testShareAccess(),
        testConnection()
    ]);

    return {
        connected: share.connected && database.connected,
        share,
        database,
        shift: shiftInfo.shift,
        shiftStart: shiftInfo.startStr,
        shiftEnd: shiftInfo.endStr,
        outputPath: BOX_DATA_PATH,
        pendingBoxes: pendingBoxes.size,
        serverTime: formatDateTime(new Date())
    };
}

async function testShareAccess() {
    try {
        await fs.access(BOX_DATA_PATH, constants.W_OK);
        return {
            connected: true,
            path: BOX_DATA_PATH
        };
    } catch (error) {
        return {
            connected: false,
            path: BOX_DATA_PATH,
            error: error.message
        };
    }
}

module.exports = router;
module.exports.getSystemStatus = getSystemStatus;
