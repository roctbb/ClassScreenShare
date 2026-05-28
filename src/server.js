'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const { Server: SocketIOServer } = require('socket.io');

const config = require('./config');
const logger = require('./logger');
const { sequelize, waitForDb } = require('./db');
const { runMigrations } = require('./db/migrator');
const { attachRenderer } = require('./lib/render');
const { buildSession } = require('./middleware/session');
const { loadUser } = require('./middleware/auth');
const { csrfState, csrfGuard } = require('./middleware/csrf');

async function bootstrap() {
    config.validate();

    logger.info({ env: config.nodeEnv, port: config.port }, 'starting ClassScreenShare');

    await waitForDb();
    logger.info('database connected');
    await runMigrations();

    // Загружаем модели после миграций (чтобы таблицы уже существовали к моменту
    // запросов). Сам require() инициализирует Sequelize-модели.
    require('./db/models');

    // Создаём первого админа из env, если таблица users пустая.
    const usersService = require('./services/users');
    await usersService.bootstrapFromEnv(config.adminBootstrap);

    const app = express();

    // helmet с относительно мягкой CSP, потому что у нас inline-скрипты в EJS
    // и socket.io клиент. Если нужно — ужесточу позже.
    app.use(
        helmet({
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false,
        })
    );
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));
    app.use(express.json({ limit: '256kb' }));
    app.use(express.urlencoded({ extended: false, limit: '256kb' }));
    app.use(cookieParser());

    app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css'), { maxAge: '7d' }));
    app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js'), { maxAge: '7d' }));

    attachRenderer(app);

    // Сессии и загрузка текущего пользователя в req.user / res.locals.user.
    const sessionMw = buildSession();
    app.use(sessionMw);
    app.use(loadUser);
    app.use(csrfState);

    // Health check для docker-compose healthcheck.
    const startedAt = Date.now();
    app.get('/healthz', async (_req, res) => {
        try {
            await sequelize.query('SELECT 1');
            const videoService = require('./services/video');
            res.json({
                status: 'ok',
                uptimeSec: Math.round((Date.now() - startedAt) / 1000),
                videoQueue: videoService.getQueueState(),
            });
        } catch (err) {
            res.status(503).json({ status: 'error', message: err.message });
        }
    });

    // Авторизация. POST /auth/login защищён CSRF-токеном из формы.
    app.use('/auth', csrfGuard, require('./routes/auth'));

    // Публичная зона участника (страница экзамена и API join/leave).
    // CSRF не накладываем — у участника нет сессии (используется cs.participant).
    const examRoute = require('./routes/exam');
    app.use(examRoute.router);

    // Админ-зона. CSRF guard только тут — на /api/exam/* участников он не нужен,
    // там нет сессии (используется cs.participant cookie).
    app.use('/admin', csrfGuard, require('./routes/admin'));

    app.get('/', (_req, res) => {
        res.renderPage('index', { title: 'ClassScreenShare', publicUrl: config.publicUrl });
    });

    // 404
    app.use((_req, res) => {
        res.status(404);
        res.renderPage('404', { title: 'Не найдено' });
    });

    // Error handler
    app.use((err, req, res, _next) => {
        req.log.error({ err }, 'request error');
        res.status(err.status || 500);
        if (res.renderPage) {
            res.renderPage('error', {
                title: 'Ошибка',
                message: config.isProd ? 'Внутренняя ошибка сервера' : err.message,
            });
        } else {
            res.type('text/plain').send('Internal Server Error');
        }
    });

    const server = http.createServer(app);
    const io = new SocketIOServer(server, {
        maxHttpBufferSize: config.maxFrameBytes + 1024,
        pingTimeout: 30000,
        pingInterval: 25000,
    });

    // Заглушка дефолтного namespace.
    io.on('connection', (socket) => {
        socket.disconnect(true);
    });

    // Подключаем namespace'ы.
    require('./sockets/publisher').attachPublisher(io);
    require('./sockets/viewer').attachViewer(io, sessionMw);

    server.listen(config.port, () => {
        logger.info({ url: config.publicUrl }, 'http server listening');
    });

    setupGracefulShutdown(server, io);

    return { app, server, io };
}

function setupGracefulShutdown(server, io) {
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ signal }, 'shutting down');

        // Останавливаем приём новых соединений
        server.close((err) => {
            if (err) logger.error({ err }, 'http server close error');
        });

        // Закрываем все socket.io соединения.
        try {
            await new Promise((resolve) => io.close(() => resolve()));
        } catch (err) {
            logger.error({ err }, 'socket.io close error');
        }

        try {
            await sequelize.close();
        } catch (err) {
            logger.error({ err }, 'sequelize close error');
        }

        // Даём 5 секунд на завершение инфлайт-запросов.
        setTimeout(() => {
            logger.info('exit');
            process.exit(0);
        }, 1000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (err) => {
        logger.fatal({ err }, 'uncaughtException');
        shutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
        logger.error({ reason }, 'unhandledRejection');
    });
}

bootstrap().catch((err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'failed to start');
    process.exit(1);
});
