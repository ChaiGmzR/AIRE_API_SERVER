const fs = require('fs/promises');
const path = require('path');
const {
    withTransaction,
    ensureBoxingRegistryTables,
    closePools
} = require('../db');
const { extractPartNumber } = require('../utils/partNumber');

const DEFAULT_BOX_DATA_PATH = '\\\\192.168.1.144\\lg-pws\\TDATA\\BOX\\DATA';
const BOX_DATA_PATH = process.env.BOX_DATA_PATH || DEFAULT_BOX_DATA_PATH;
const FILE_PATTERN = /^([A-Z]{2,4}\d{10,15})_(\d{14})\.txt$/i;

async function main() {
    await ensureBoxingRegistryTables();

    const entries = await fs.readdir(BOX_DATA_PATH, { withFileTypes: true });
    const files = entries
        .filter(entry => entry.isFile() && FILE_PATTERN.test(entry.name))
        .map(entry => entry.name);

    let boxesInserted = 0;
    let piecesInserted = 0;
    let skippedBoxes = 0;

    for (const fileName of files) {
        const match = fileName.match(FILE_PATTERN);
        const boxCode = match[1].toUpperCase();
        const filePath = path.win32.join(BOX_DATA_PATH, fileName);
        const fileRows = (await fs.readFile(filePath, 'utf8'))
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => line.split('|'))
            .filter(columns => columns[0]);

        if (fileRows.length === 0) {
            continue;
        }

        const registeredAt = parseFileDate(match[2]);
        const partNumber = extractPartNumber(fileRows[0][0]) || 'UNKNOWN';
        const inserted = await withTransaction(async connection => {
            const [existing] = await connection.execute(
                'SELECT box_code FROM aire_box_registry WHERE box_code = ? LIMIT 1',
                [boxCode]
            );

            if (existing.length > 0) {
                return false;
            }

            await connection.execute(
                `INSERT INTO aire_box_registry
                    (box_code, part_number, production_type, line_code, file_name, row_count, status, registered_at)
                 VALUES (?, ?, 'LEGACY', 'LEGACY', ?, ?, 'SENT', ?)`,
                [boxCode, partNumber, fileName, fileRows.length, registeredAt]
            );

            for (const columns of fileRows) {
                const barcode = columns[0].trim();
                const scannedAt = parseLegacyDate(columns[2]) || registeredAt;
                const [result] = await connection.execute(
                    `INSERT IGNORE INTO aire_piece_registry
                        (barcode, box_code, part_number, production_type, line_code, scanned_at, registered_at)
                     VALUES (?, ?, ?, 'LEGACY', 'LEGACY', ?, ?)`,
                    [barcode, boxCode, extractPartNumber(barcode) || partNumber, scannedAt, registeredAt]
                );
                piecesInserted += result.affectedRows;
            }

            return true;
        });

        if (inserted) {
            boxesInserted += 1;
        } else {
            skippedBoxes += 1;
        }
    }

    console.log(JSON.stringify({
        path: BOX_DATA_PATH,
        files: files.length,
        boxesInserted,
        piecesInserted,
        skippedBoxes
    }, null, 2));
}

function parseFileDate(value) {
    const year = Number.parseInt(value.substring(0, 4), 10);
    const month = Number.parseInt(value.substring(4, 6), 10) - 1;
    const day = Number.parseInt(value.substring(6, 8), 10);
    const hour = Number.parseInt(value.substring(8, 10), 10);
    const minute = Number.parseInt(value.substring(10, 12), 10);
    const second = Number.parseInt(value.substring(12, 14), 10);
    return new Date(year, month, day, hour, minute, second);
}

function parseLegacyDate(value) {
    if (!value) {
        return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

main()
    .catch(error => {
        console.error('Error en la migracion del registro de empaque:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closePools();
    });
