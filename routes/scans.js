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
const PRODUCTION_TYPES = {
    MAIN_PCB: {
        label: 'MAIN PCB',
        lines: ['M1', 'M2', 'M3', 'M4']
    },
    DISPLAY: {
        label: 'DISPLAY',
        lines: ['D1', 'D2', 'D3']
    }
};

const pendingBoxes = new Map();
const scanHistory = [];

/**
 * POST /api/scans
 * Register a pending piece scan for the active box.
 * Body: { boxCode, barcode, productionType, lineCode }
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

        const productionValidation = validateProductionSelection(req.body);
        if (!productionValidation.valid) {
            return res.status(400).json({ error: productionValidation.error });
        }

        const existingBoxScans = pendingBoxes.get(boxValidation.boxId) || [];
        const duplicate = existingBoxScans.some(scan => scan.serial === barcodeValidation.barcode);
        if (duplicate) {
            return res.status(409).json({ error: 'Este BarCode ya fue escaneado en esta caja' });
        }

        const boxProductionValidation = validateBoxProductionSelection(existingBoxScans, productionValidation.selection);
        if (!boxProductionValidation.valid) {
            return res.status(409).json({ error: boxProductionValidation.error });
        }

        const partValidation = validateBoxPartNumber(existingBoxScans, barcodeValidation.partNumber);
        if (!partValidation.valid) {
            return res.status(409).json({ error: partValidation.error });
        }

        const testStatus = await validateQualityStatus(
            barcodeValidation.barcode,
            barcodeValidation.partNumber,
            productionValidation.selection
        );
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
            productionType: productionValidation.selection.productionType,
            productionLabel: productionValidation.selection.productionLabel,
            lineCode: productionValidation.selection.lineCode,
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
                productionType: scan.productionType,
                productionLabel: scan.productionLabel,
                lineCode: scan.lineCode,
                scanTime: scan.firstScan
            },
            counts: {
                box: boxScans.length,
                shift: getShiftCount(scan.partNumber)
            }
        });
    } catch (error) {
        console.error('Error registering pending scan:', error);
        res.status(500).json({ error: 'Error al registrar el escaneo', details: error.message });
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
            return res.status(400).json({ error: 'No hay escaneos pendientes para esta caja' });
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
        res.status(500).json({ error: 'Error al generar el archivo BOX', details: error.message });
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
        res.status(500).json({ error: 'Error al obtener el contador', details: error.message });
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
                partNumber: extractPartNumber(scan.serial),
                productionType: scan.productionType,
                productionLabel: scan.productionLabel,
                lineCode: scan.lineCode
            }))
        });
    } catch (error) {
        console.error('Error getting pending box scans:', error);
        res.status(500).json({ error: 'Error al obtener escaneos pendientes', details: error.message });
    }
});

/**
 * DELETE /api/scans/box/:boxCode/scan/:barcode
 * Delete one pending scan from a box.
 */
router.delete('/box/:boxCode/scan/:barcode', (req, res) => {
    try {
        const { boxCode, barcode } = req.params;

        const boxValidation = validateBoxId(boxCode);
        if (!boxValidation.valid) {
            return res.status(400).json({ error: boxValidation.error });
        }

        const barcodeValidation = validateBarCode(barcode);
        if (!barcodeValidation.valid) {
            return res.status(400).json({ error: barcodeValidation.error });
        }

        const boxScans = pendingBoxes.get(boxValidation.boxId);
        if (!boxScans || boxScans.length === 0) {
            return res.json({
                success: true,
                alreadyDeleted: true,
                boxCode: boxValidation.boxId,
                deleted: null,
                currentPartNumber: null,
                counts: {
                    box: 0,
                    shift: getShiftCount(barcodeValidation.partNumber)
                }
            });
        }

        const scanIndex = boxScans.findIndex(scan => scan.serial === barcodeValidation.barcode);
        if (scanIndex === -1) {
            const currentPartNumber = boxScans[0]?.partNumber || null;
            return res.json({
                success: true,
                alreadyDeleted: true,
                boxCode: boxValidation.boxId,
                deleted: {
                    serial: barcodeValidation.barcode,
                    partNumber: barcodeValidation.partNumber
                },
                currentPartNumber,
                counts: {
                    box: boxScans.length,
                    shift: getShiftCount(currentPartNumber || barcodeValidation.partNumber)
                }
            });
        }

        const [deletedScan] = boxScans.splice(scanIndex, 1);
        renumberBoxScans(boxScans);

        if (boxScans.length === 0) {
            pendingBoxes.delete(boxValidation.boxId);
        }

        const currentPartNumber = boxScans[0]?.partNumber || null;
        res.json({
            success: true,
            boxCode: boxValidation.boxId,
            deleted: {
                id: deletedScan.id,
                serial: deletedScan.serial,
                partNumber: deletedScan.partNumber
            },
            currentPartNumber,
            counts: {
                box: boxScans.length,
                shift: getShiftCount(deletedScan.partNumber)
            }
        });
    } catch (error) {
        console.error('Error deleting pending scan:', error);
        res.status(500).json({ error: 'Error al eliminar el escaneo', details: error.message });
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
        res.status(500).json({ error: 'Error al limpiar los escaneos pendientes de la caja', details: error.message });
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

function renumberBoxScans(boxScans) {
    boxScans.forEach((scan, index) => {
        scan.id = index + 1;
    });
}

function validateProductionSelection(body = {}) {
    const productionType = normalizeProductionType(
        body.productionType || body.productType || body.processType || body.flow || 'MAIN_PCB'
    );
    if (!productionType || !PRODUCTION_TYPES[productionType]) {
        return {
            valid: false,
            error: 'Tipo de produccion invalido. Valores permitidos: MAIN PCB, DISPLAY'
        };
    }

    const allowedLines = PRODUCTION_TYPES[productionType].lines;
    const lineCode = normalizeStatus(
        body.lineCode || body.line || body.productionLine || allowedLines[0]
    );
    if (!allowedLines.includes(lineCode)) {
        return {
            valid: false,
            error: `Linea invalida para ${PRODUCTION_TYPES[productionType].label}. Lineas permitidas: ${allowedLines.join(', ')}`
        };
    }

    return {
        valid: true,
        selection: {
            productionType,
            productionLabel: PRODUCTION_TYPES[productionType].label,
            lineCode
        }
    };
}

function normalizeProductionType(value) {
    const normalized = normalizeStatus(value).replace(/[\s-]+/g, '_');
    if (normalized === 'MAIN' || normalized === 'MAINPCB' || normalized === 'MAIN_PCB') {
        return 'MAIN_PCB';
    }

    if (normalized === 'DISPLAY') {
        return 'DISPLAY';
    }

    return normalized;
}

function validateBoxProductionSelection(boxScans, selection) {
    if (boxScans.length === 0) {
        return { valid: true };
    }

    const expectedProductionType = boxScans[0].productionType || 'MAIN_PCB';
    const expectedLineCode = boxScans[0].lineCode || PRODUCTION_TYPES[expectedProductionType]?.lines[0];

    if (expectedProductionType === selection.productionType && expectedLineCode === selection.lineCode) {
        return { valid: true };
    }

    return {
        valid: false,
        error: `La linea de produccion no coincide. Esperado ${formatProductionSelection(expectedProductionType, expectedLineCode)}, recibido ${formatProductionSelection(selection.productionType, selection.lineCode)}`
    };
}

function formatProductionSelection(productionType, lineCode) {
    const productionLabel = PRODUCTION_TYPES[productionType]?.label || productionType;
    return `${productionLabel} ${lineCode || ''}`.trim();
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
        error: `Numero de parte distinto. Esperado ${expectedPartNumber}, recibido ${partNumber}`
    };
}

async function validateQualityStatus(barcode, partNumber, productionSelection) {
    if (productionSelection.productionType === 'DISPLAY') {
        return validateDisplayQualityStatus(barcode, partNumber, productionSelection);
    }

    return validateMainPcbQualityStatus(barcode);
}

async function validateMainPcbQualityStatus(barcode) {
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
            `SELECT final_result, COALESCE(end_at, start_at, file_modified_at, created_at) AS test_ts
             FROM fct_test_results
             WHERE serial_number = ?
             ORDER BY COALESCE(end_at, start_at, file_modified_at, created_at) DESC
             LIMIT 1`,
            [barcode]
        )
    ]);

    const ict = ictRows[0] || null;
    const fct = fctRows[0] || null;
    const quality = {
        productionType: 'MAIN_PCB',
        ict: {
            found: Boolean(ict),
            status: ict?.resultado || null,
            timestamp: ict?.ts || null
        },
        fct: {
            found: Boolean(fct),
            status: fct ? normalizeFctStatus(fct.final_result) : null,
            rawStatus: fct?.final_result || null,
            timestamp: fct?.test_ts || null
        }
    };

    if (!ict) {
        return { valid: false, error: 'No se encontro estatus ICT para este BarCode', quality };
    }

    if (normalizeStatus(ict.resultado) !== 'OK') {
        return { valid: false, error: `El estatus ICT debe ser OK. Estatus actual: ${ict.resultado}`, quality };
    }

    if (!fct) {
        return { valid: false, error: 'No se encontro estatus FCT para este BarCode', quality };
    }

    if (normalizeFctStatus(fct.final_result) !== 'OK') {
        return { valid: false, error: `El estatus FCT debe ser OK. Estatus actual: ${fct.final_result}`, quality };
    }

    return { valid: true, quality };
}

async function validateDisplayQualityStatus(barcode, partNumber, productionSelection) {
    const searchValues = getDisplaySearchValues(barcode, partNumber);
    const placeholders = searchValues.map(() => '?').join(', ');
    const rows = await query(
        `SELECT raw, event_id, ts, fecha, nparte, modelo, lot_no, linea, lado, display_verificado,
                CASE
                    WHEN raw IN (${placeholders})
                      OR lot_no IN (${placeholders})
                      OR event_id IN (${placeholders})
                    THEN 0
                    ELSE 1
                END AS match_rank
         FROM history_prueba_electrica
         WHERE raw IN (${placeholders})
            OR lot_no IN (${placeholders})
            OR event_id IN (${placeholders})
            OR nparte IN (${placeholders})
         ORDER BY match_rank ASC, ts DESC
         LIMIT 1`,
        [
            ...searchValues,
            ...searchValues,
            ...searchValues,
            ...searchValues,
            ...searchValues,
            ...searchValues,
            ...searchValues
        ]
    );

    const display = rows[0] || null;
    const testedLine = normalizeStatus(display?.linea);
    const electricalStatus = display ? normalizeElectricalStatus(display.display_verificado) : null;
    const quality = {
        productionType: 'DISPLAY',
        electrical: {
            found: Boolean(display),
            status: electricalStatus,
            rawStatus: display?.display_verificado ?? null,
            line: display?.linea || null,
            expectedLine: productionSelection.lineCode,
            partNumber: display?.nparte || null,
            model: display?.modelo || null,
            lotNo: display?.lot_no || null,
            eventId: display?.event_id || null,
            side: display?.lado || null,
            timestamp: display?.ts || null
        }
    };

    if (!display) {
        return { valid: false, error: 'No se encontro prueba electrica para este BarCode', quality };
    }

    if (electricalStatus !== 'OK') {
        return {
            valid: false,
            error: `La prueba electrica debe estar OK. Estatus actual: ${formatElectricalStatus(display.display_verificado)}`,
            quality
        };
    }

    if (testedLine && testedLine !== productionSelection.lineCode) {
        return {
            valid: false,
            error: `La linea de prueba electrica no coincide. Esperado ${productionSelection.lineCode}, recibido ${display.linea}`,
            quality
        };
    }

    return { valid: true, quality };
}

function getDisplaySearchValues(barcode, partNumber) {
    const values = [];
    addUniqueValue(values, barcode);
    addUniqueValue(values, partNumber);

    for (const segment of String(barcode || '').split('ñ')) {
        addUniqueValue(values, segment);
    }

    return values;
}

function addUniqueValue(values, value) {
    const normalized = String(value || '').trim();
    if (normalized && !values.includes(normalized)) {
        values.push(normalized);
    }
}

function normalizeStatus(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeFctStatus(value) {
    const status = normalizeStatus(value);
    if (status === 'PASS') {
        return 'OK';
    }

    if (status === 'FAIL') {
        return 'NG';
    }

    return status;
}

function normalizeElectricalStatus(value) {
    if (value === true || value === 1) {
        return 'OK';
    }

    if (value === false || value === 0) {
        return 'NG';
    }

    const status = normalizeStatus(value);
    if (['1', 'OK', 'PASS', 'TRUE', 'VERIFIED', 'SI', 'YES'].includes(status)) {
        return 'OK';
    }

    if (['0', 'NG', 'FAIL', 'FALSE', 'NOT_VERIFIED', 'NO'].includes(status)) {
        return 'NG';
    }

    return status;
}

function formatElectricalStatus(value) {
    return normalizeElectricalStatus(value) || 'UNKNOWN';
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

    throw new Error('No se pudo asignar un nombre unico para el archivo BOX');
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
