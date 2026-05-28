'use strict';

require('dotenv').config();

const path = require('path');

function int(name, def) {
    const v = process.env[name];
    if (v === undefined || v === '') return def;
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) {
        throw new Error(`Env ${name}=${v} is not a valid integer`);
    }
    return n;
}

function float(name, def) {
    const v = process.env[name];
    if (v === undefined || v === '') return def;
    const n = parseFloat(v);
    if (Number.isNaN(n)) {
        throw new Error(`Env ${name}=${v} is not a valid float`);
    }
    return n;
}

function str(name, def) {
    const v = process.env[name];
    if (v === undefined || v === '') return def;
    return v;
}

// Зарезервировано на будущее (для опциональных env-переключателей).
function _bool(name, def) {
    const v = process.env[name];
    if (v === undefined || v === '') return def;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const NODE_ENV = str('NODE_ENV', 'development');
const RECORDINGS_DIR = path.resolve(str('RECORDINGS_DIR', './recordings'));
const ASSET_VERSION = str('ASSET_VERSION', String(Date.now()));

const config = {
    nodeEnv: NODE_ENV,
    isProd: NODE_ENV === 'production',
    port: int('PORT', 3000),
    logLevel: str('LOG_LEVEL', 'info'),
    publicUrl: str('PUBLIC_URL', `http://localhost:${int('PORT', 3000)}`).replace(/\/$/, ''),
    assetVersion: ASSET_VERSION,

    sessionSecret: str('SESSION_SECRET', null),

    db: {
        host: str('DB_HOST', 'localhost'),
        port: int('DB_PORT', 5432),
        name: str('DB_NAME', 'classscreenshare'),
        user: str('DB_USER', 'classscreenshare'),
        password: str('DB_PASSWORD', 'classscreenshare'),
    },

    adminBootstrap: {
        login: str('ADMIN_LOGIN', null),
        password: str('ADMIN_PASSWORD', null),
    },

    geekclass: {
        host: str('GEEKCLASS_HOST', null),
        jwtSecret: str('GEEKCLASS_JWT_SECRET', null),
        get enabled() {
            return Boolean(this.host && this.jwtSecret);
        },
    },

    recordingsDir: RECORDINGS_DIR,

    capture: {
        interval: int('DEFAULT_CAPTURE_INTERVAL', 5000),
        quality: float('DEFAULT_IMAGE_QUALITY', 0.8),
        width: int('DEFAULT_IMAGE_WIDTH', 1080),
    },

    inactivityTimeout: int('INACTIVITY_TIMEOUT', 15000),

    video: {
        fps: float('VIDEO_FPS', 2),
        format: str('VIDEO_FORMAT', 'mp4'),
        maxGapSeconds: float('VIDEO_MAX_GAP_SECONDS', 5),
        concurrency: int('VIDEO_CONCURRENCY', 2),
    },

    maxFrameBytes: int('MAX_FRAME_BYTES', 2 * 1024 * 1024),
};

function validate() {
    const errors = [];
    if (!config.sessionSecret || config.sessionSecret.length < 16) {
        if (config.isProd) {
            errors.push('SESSION_SECRET must be set and >= 16 chars in production');
        }
    }
    if (config.geekclass.host && !config.geekclass.host.startsWith('http')) {
        errors.push('GEEKCLASS_HOST must start with http:// or https://');
    }
    if (errors.length) {
        const msg = `Config errors:\n  - ${errors.join('\n  - ')}`;
        throw new Error(msg);
    }
}

config.validate = validate;

module.exports = config;
