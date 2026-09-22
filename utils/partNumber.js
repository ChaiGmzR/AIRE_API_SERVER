/**
 * Parse production barcodes and SMD QR codes without mixing their formats.
 * Production barcodes use their first 11 characters as the part number.
 * SMD QR codes use the field after MAIN as the part number and are normalized
 * to semicolon-separated fields for database lookups and BOX files.
 */
function parseBarcode(barcode) {
    if (!barcode || typeof barcode !== 'string') {
        return null;
    }

    const trimmed = barcode.trim();
    if (!trimmed) {
        return null;
    }

    const smdQr = parseSmdQr(trimmed);
    if (smdQr) {
        return smdQr;
    }

    if (trimmed.startsWith('I') && /[ñ;]/.test(trimmed)) {
        return null;
    }

    if (trimmed.length < 11) {
        return null;
    }

    return {
        barcode: trimmed,
        partNumber: trimmed.substring(0, 11),
        type: 'PRODUCTION',
        comparisonKey: trimmed.toUpperCase()
    };
}

function parseSmdQr(value) {
    if (!value.startsWith('I') || !/[ñ;]/.test(value)) {
        return null;
    }

    const fields = value.split(/[ñ;]/);
    while (fields.length > 0 && fields[fields.length - 1] === '') {
        fields.pop();
    }

    if (fields.length !== 4 || fields[1].toUpperCase() !== 'MAIN') {
        return null;
    }

    const header = fields[0].split(/[-'’]/);
    if (
        header.length !== 3 ||
        !/^I\d{8}$/.test(header[0]) ||
        !header[1] ||
        !/^\d+$/.test(header[2]) ||
        !fields[2] ||
        !fields[3]
    ) {
        return null;
    }

    const normalized = `${header.join('-')};${fields.slice(1).join(';')};`;
    return {
        barcode: normalized,
        partNumber: fields[2],
        type: 'SMD_QR',
        comparisonKey: normalized
    };
}

function extractPartNumber(barcode) {
    return parseBarcode(barcode)?.partNumber || null;
}

/**
 * Validate Box ID format (e.g., "LGB922602036126")
 */
function validateBoxId(boxId) {
    if (!boxId || typeof boxId !== 'string') {
        return { valid: false, error: 'El Box Id es requerido' };
    }

    const trimmed = boxId.trim();

    // Basic validation: should start with letters and contain numbers
    if (!/^[A-Z]{2,4}\d{10,15}$/.test(trimmed)) {
        return { valid: false, error: 'Formato de Box Id invalido' };
    }

    return { valid: true, boxId: trimmed };
}

/**
 * Validate BarCode format
 */
function validateBarCode(barcode, options = {}) {
    if (!barcode || typeof barcode !== 'string') {
        return { valid: false, error: 'El BarCode es requerido' };
    }

    const trimmed = barcode.trim();

    if (trimmed.length < 11) {
        return { valid: false, error: 'BarCode demasiado corto (minimo 11 caracteres)' };
    }

    const parsed = parseBarcode(trimmed);
    if (!parsed) {
        if (trimmed.startsWith('I') && /[ñ;]/.test(trimmed)) {
            return { valid: false, error: 'Formato de QR SMD invalido' };
        }

        return { valid: false, error: 'No se pudo extraer el numero de parte del BarCode' };
    }

    if (options.productionType === 'MAIN_PCB' && parsed.type === 'SMD_QR') {
        return { valid: false, error: 'MAIN PCB solo acepta Barcode de produccion' };
    }

    return {
        valid: true,
        barcode: parsed.barcode,
        originalBarcode: trimmed,
        partNumber: parsed.partNumber,
        barcodeType: parsed.type,
        comparisonKey: parsed.comparisonKey
    };
}

module.exports = {
    parseBarcode,
    parseSmdQr,
    extractPartNumber,
    validateBoxId,
    validateBarCode
};
