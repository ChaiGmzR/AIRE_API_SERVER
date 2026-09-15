/**
 * Extract part number from various BarCode formats
 * 
 * Supported formats:
 * 1. "EBR24212304922602030706" → first 11 chars = "EBR24212304"
 * 2. "I20260203'0027'00420ñMAINñEBR24212304ñ1ñ" → extract between ñ = "EBR24212304"
 * 3. "EBR24212304" → use as-is (11 chars)
 */
function extractPartNumber(barcode) {
    if (!barcode || typeof barcode !== 'string') {
        return null;
    }

    const trimmed = barcode.trim();

    // Format 2: Contains ñ delimiter (e.g., "I20260203'0027'00420ñMAINñEBR24212304ñ1ñ")
    if (trimmed.includes('ñ')) {
        const parts = trimmed.split('ñ');
        // Find the part that starts with typical part number prefixes (EBR, etc.)
        for (const part of parts) {
            if (part.length >= 11 && /^[A-Z]{3}\d{8}/.test(part)) {
                return part.substring(0, 11);
            }
        }
        // Fallback: return the third segment if it exists and has right length
        if (parts.length >= 3 && parts[2].length >= 11) {
            return parts[2].substring(0, 11);
        }
    }

    // Format 1 & 3: Standard barcode - first 11 characters
    if (trimmed.length >= 11) {
        return trimmed.substring(0, 11);
    }

    // If barcode is shorter, return as-is
    return trimmed;
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
function validateBarCode(barcode) {
    if (!barcode || typeof barcode !== 'string') {
        return { valid: false, error: 'El BarCode es requerido' };
    }

    const trimmed = barcode.trim();

    if (trimmed.length < 11) {
        return { valid: false, error: 'BarCode demasiado corto (minimo 11 caracteres)' };
    }

    const partNumber = extractPartNumber(trimmed);
    if (!partNumber) {
        return { valid: false, error: 'No se pudo extraer el numero de parte del BarCode' };
    }

    return { valid: true, barcode: trimmed, partNumber };
}

module.exports = {
    extractPartNumber,
    validateBoxId,
    validateBarCode
};
