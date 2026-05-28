'use strict';

const session = require('express-session');
const ConnectPgSimple = require('connect-pg-simple');
const config = require('../config');

const PgStore = ConnectPgSimple(session);

/**
 * Создаёт middleware для express-session, использующий Postgres как хранилище.
 * Таблица "session" уже создана миграцией, поэтому createTableIfMissing=false.
 *
 * Создание middleware идемпотентное (singleton), чтобы express и socket.io
 * могли использовать один и тот же экземпляр (важно для общего store).
 */
let _instance = null;

function buildSession() {
    if (_instance) return _instance;
    const store = new PgStore({
        conObject: {
            host: config.db.host,
            port: config.db.port,
            database: config.db.name,
            user: config.db.user,
            password: config.db.password,
        },
        tableName: 'session',
        createTableIfMissing: false,
        // Чистка устаревших сессий раз в 15 минут.
        pruneSessionInterval: 15 * 60,
    });

    _instance = session({
        store,
        secret: config.sessionSecret,
        name: 'cs.sid',
        resave: false,
        // Создаём сессию для каждого посетителя, чтобы CSRF-токен мог жить
        // в session ещё до логина. connect-pg-simple вычистит истёкшие.
        saveUninitialized: true,
        rolling: true,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: config.isProd && config.publicUrl.startsWith('https://'),
            // 7 дней. Админы не часто заходят, длинный срок ок.
            maxAge: 7 * 24 * 60 * 60 * 1000,
        },
    });
    return _instance;
}

module.exports = { buildSession };
