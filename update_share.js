const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const INSTALLER_PATTERN = /^AIRE_Setup_(\d+\.\d+\.\d+)\.exe$/i;

const UPDATE_SHARE_ROOT = process.env.UPDATE_SHARE_ROOT ||
    '\\\\192.168.1.10\\updates\\CALIDAD\\AIRE';
const UPDATE_SHARE_USER = process.env.UPDATE_SHARE_USER || '';
const UPDATE_SHARE_PASSWORD = process.env.UPDATE_SHARE_PASSWORD || '';

async function connectUpdateShare() {
    if (process.platform !== 'win32') {
        throw new Error('El recurso de actualizaciones requiere Windows');
    }

    const shareRoot = getShareRoot(UPDATE_SHARE_ROOT);
    let authenticated = false;

    if (UPDATE_SHARE_USER || UPDATE_SHARE_PASSWORD) {
        if (!UPDATE_SHARE_USER || !UPDATE_SHARE_PASSWORD) {
            throw new Error('La configuracion del recurso de actualizaciones esta incompleta');
        }

        try {
            await execFileAsync(
                'net.exe',
                [
                    'use',
                    shareRoot,
                    UPDATE_SHARE_PASSWORD,
                    `/user:${UPDATE_SHARE_USER}`,
                    '/persistent:no'
                ],
                { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }
            );
            authenticated = true;
        } catch (_) {
            throw new Error('No se pudo autenticar el recurso de actualizaciones');
        }
    }

    try {
        await fs.access(UPDATE_SHARE_ROOT);
    } catch (_) {
        if (authenticated) {
            await disconnectUpdateShare(shareRoot);
        }
        throw new Error('El recurso de actualizaciones no esta disponible');
    }

    return {
        root: UPDATE_SHARE_ROOT,
        close: async () => {
            if (authenticated) {
                await disconnectUpdateShare(shareRoot);
            }
        }
    };
}

async function disconnectUpdateShare(shareRoot) {
    try {
        await execFileAsync(
            'net.exe',
            ['use', shareRoot, '/delete', '/y'],
            { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }
        );
    } catch (_) {
        console.warn('No se pudo cerrar la sesion temporal del recurso de actualizaciones');
    }
}

async function getLatestInstaller() {
    const share = await connectUpdateShare();
    try {
        const entries = await fs.readdir(share.root, { withFileTypes: true });
        const installers = entries
            .filter((entry) => entry.isFile())
            .map((entry) => {
                const match = INSTALLER_PATTERN.exec(entry.name);
                return match ? { name: entry.name, version: match[1] } : null;
            })
            .filter(Boolean)
            .sort((a, b) => compareVersions(b.version, a.version));

        if (installers.length === 0) {
            throw new Error('No hay instaladores AIRE disponibles');
        }

        const latest = installers[0];
        const filePath = path.win32.join(share.root, latest.name);
        const stats = await fs.stat(filePath);
        return {
            version: latest.version,
            fileName: latest.name,
            size: stats.size,
            modifiedAt: stats.mtime.toISOString()
        };
    } finally {
        await share.close();
    }
}

function validateVersion(version) {
    return VERSION_PATTERN.test(String(version || '').trim());
}

function installerPath(version) {
    if (!validateVersion(version)) {
        throw new Error('Version de actualizacion invalida');
    }

    return path.win32.join(
        UPDATE_SHARE_ROOT,
        `AIRE_Setup_${version}.exe`
    );
}

function getShareRoot(root) {
    const match = /^\\\\[^\\]+\\[^\\]+/.exec(root);
    if (!match) {
        throw new Error('UPDATE_SHARE_ROOT no es una ruta UNC valida');
    }

    return match[0];
}

function compareVersions(a, b) {
    const left = a.match(VERSION_PATTERN).slice(1).map(Number);
    const right = b.match(VERSION_PATTERN).slice(1).map(Number);
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) {
            return left[index] - right[index];
        }
    }
    return 0;
}

module.exports = {
    connectUpdateShare,
    getLatestInstaller,
    installerPath,
    validateVersion
};
