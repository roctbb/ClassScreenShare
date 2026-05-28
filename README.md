# ClassScreenShare 2.0

Система прокторинга экзаменов: участники транслируют свои экраны через браузер, преподаватель в реальном времени видит сетку экранов, а сервер пишет каждый кадр и собирает из них видео с правильным таймлайном пропусков связи.

## Возможности

- **Локальная авторизация** для админов (bcrypt) и опциональный вход через GeekClass (JWT-handshake).
- **Экзамены** как объект первого класса: создаётся через админку, получает короткий инвайт-код. Участники подключаются по ссылке `/exam/<code>`, без аккаунта.
- **Захват экрана** через `getDisplayMedia` + WebP в браузере; кадр раз в 5 секунд (настраивается).
- **Запись на сервер**: каждый кадр сохраняется на диск и пишется в Postgres (timestamp, путь, размер). База — источник истины для таймлайна.
- **Live-мониторинг** для админа: сетка экранов с обновлением в реальном времени, лог подключений, fullscreen клика, **звуковой сигнал** когда участник перестал слать кадры.
- **Звуковой сигнал у участника** при потере связи (повтор каждые 3 сек до восстановления).
- **Возврат в свою сессию**: токен в cookie позволяет переподключиться и продолжить запись после reload.
- **Конвертация в видео** через ffmpeg с правильными `duration` для каждого кадра. Длинные пропуски связи (`> VIDEO_MAX_GAP_SECONDS`) сжимаются в видео до этой границы, но отмечены красным на таймлайне с подсказкой «нет связи N сек».
- **Встроенный плеер** на странице участника: HTML5 `<video>` или slideshow по кадрам (если ещё не сконвертировано), скорости 0.5/1/1.5/2/4/8, кастомный SVG-таймлайн с зелёными/красными сегментами, hover-tooltip, клик-перемотка.
- **Корректное завершение экзамена**: при finish все активные publishers получают `kicked` событие и отключаются. Сразу после этого автоматически запускается конвертация всех записей в видео. После delete — каскад в БД и очистка файлов с диска.
- **Real-time прогресс конвертации** в админке: статусные бейджи (pending → running → done/failed) обновляются через socket.io без перезагрузки страницы.
- **Экспорт списка участников в CSV** с UTF-8 BOM (открывается в Excel).

## Стек

- Node.js 20, Express 4, Socket.IO 4, EJS
- PostgreSQL 16, Sequelize 6 (с миграциями)
- bcrypt, express-session + connect-pg-simple, helmet
- jsonwebtoken (для GeekClass), zod (валидация), pino (логи)
- ffmpeg для конвертации
- Docker / docker-compose

## Быстрый старт (Docker)

```bash
cp .env.example .env
# Откройте .env и установите минимум:
#   SESSION_SECRET=  (любая случайная строка >= 16 символов)
#   ADMIN_LOGIN=admin
#   ADMIN_PASSWORD=<надёжный пароль>
#   PUBLIC_URL=https://your-domain.tld    # для production
docker compose up -d --build
```

После этого:

- `http://localhost:3000` — главная
- `http://localhost:3000/admin` — админка (логин из ADMIN_LOGIN/ADMIN_PASSWORD)
- `http://localhost:3000/exam/<КОД>` — страница участника

## Локальный запуск (без Docker)

Нужны: Node.js 20+, ffmpeg, Postgres 16.

```bash
# Postgres из docker:
docker run -d --name cs-pg -p 5432:5432 \
  -e POSTGRES_DB=classscreenshare \
  -e POSTGRES_USER=classscreenshare \
  -e POSTGRES_PASSWORD=classscreenshare \
  postgres:16-alpine

npm install
cp .env.example .env
# В .env установите DB_HOST=localhost (или ваш) и SESSION_SECRET.
npm run migrate
npm start
```

## Конфигурация

Все переменные описаны в `.env.example`. Ключевые:

| Переменная                              | Описание                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`                        | Секрет для express-session, обязателен в production.                                                            |
| `ADMIN_LOGIN`/`ADMIN_PASSWORD`          | Учётка первого админа, создаётся при первом старте, если таблица `users` пуста.                                 |
| `PUBLIC_URL`                            | Базовый URL приложения. Используется в инвайт-ссылках и callback от GeekClass.                                  |
| `GEEKCLASS_HOST`/`GEEKCLASS_JWT_SECRET` | Включают вход через GeekClass. Если не заданы — только локальная авторизация.                                   |
| `DEFAULT_CAPTURE_INTERVAL`              | Интервал захвата кадров (мс). По умолчанию 5000.                                                                |
| `DEFAULT_IMAGE_QUALITY`                 | Качество WebP, 0..1.                                                                                            |
| `DEFAULT_IMAGE_WIDTH`                   | Целевая ширина кадра в пикселях.                                                                                |
| `INACTIVITY_TIMEOUT`                    | Через сколько мс молчания участника срабатывает звуковой сигнал у админа.                                       |
| `VIDEO_MAX_GAP_SECONDS`                 | Максимальная длительность одного «кадра» в результирующем видео. Длинные пропуски обрезаются до этого значения. |
| `VIDEO_CONCURRENCY`                     | Сколько ffmpeg-задач выполнять параллельно.                                                                     |
| `MAX_FRAME_BYTES`                       | Лимит на размер одного кадра в байтах.                                                                          |

## CLI-команды

```bash
# Создать ещё одного локального админа:
docker compose exec app node scripts/manage.js create-admin <login> <password>

# Список админов:
docker compose exec app node scripts/manage.js list-admins

# Сменить пароль:
docker compose exec app node scripts/manage.js reset-password <login> <password>
```

Без Docker то же самое запускается через `npm run manage create-admin ...`.

## Разработка

```bash
npm run dev            # запуск с nodemon (автоперезапуск)
npm test               # юнит + интеграционные тесты с Postgres (поднимает контейнер)
npm run test:watch     # vitest watch-режим
npm run lint           # eslint
npm run lint:fix       # eslint с автофиксами
npm run format         # prettier --write
npm run format:check   # prettier --check
npm run migrate        # применить миграции вручную
```

Тесты с БД сами поднимают временный postgres-контейнер `cs-pg-test:5433`. Чтобы оставить контейнер после прогона (для отладки), задайте `KEEP_TEST_DB=1`. Требуется Docker.

## Структура

```
src/
  server.js              точка входа
  config.js              парсинг env с валидацией
  logger.js              pino (JSON в prod, pretty в dev)
  db/
    index.js             инициализация sequelize + waitForDb
    migrator.js          программный запуск миграций при старте
    sequelize-cli.cjs    конфиг для ручного запуска через npm run migrate
    models/              User, Exam, Participant, Frame, Recording
    migrations/          users → exams → participants → frames → recordings → session
  lib/
    render.js            обёртка для рендера view с layout
    util.js              generateCode, safeNext
  middleware/
    auth.js              loadUser, requireAuth
    session.js           express-session + connect-pg-simple (Postgres)
    csrf.js              csrfState, csrfGuard (защита admin POST'ов)
  routes/
    auth.js              /auth/login, /auth/logout, /auth/geekclass[/callback]
    exam.js              /exam/:code, /api/exam/:code/join|leave (zod валидация)
    admin.js             /admin/*, CRUD экзаменов, плеер, API recordings
  sockets/
    publisher.js         namespace /publisher: handshake по cs.participant cookie
    viewer.js            namespace /viewer: handshake по сессии админа
  services/
    bus.js               in-process EventEmitter для связи модулей
    users.js             bcrypt, bootstrapFromEnv, upsertGeekclassUser
    geekclass.js         JWT-валидация (HS256, iat ±60 сек)
    exams.js             createExam (с retry на коллизию кода), CRUD, deleteExam (БД + диск)
    participants.js      joinOrResume по cookie-токену
    frames.js            saveFrame с rate-limit и back-pressure
    video.js             buildTimeline, ffmpeg pipeline, очередь задач
  views/                 EJS-шаблоны (admin/, exam/, layouts/)
public/
  css/main.css
  js/exam.js             клиент участника
  js/live.js             клиент live-мониторинга
  js/player.js           клиент плеера
scripts/
  manage.js              CLI для управления админами
recordings/              хранилище кадров и видео (в Docker — volume)
```

## Хранилище

```
recordings/
└── exam_<id>/
    └── participant_<id>/
        ├── frames/
        │   ├── <ts>.webp        ← каждый кадр участника
        │   └── ...
        ├── timeline.json        ← сгенерирован при конвертации
        └── recording.mp4        ← сгенерирован при конвертации
```

В Docker папка монтируется как volume `./recordings:/app/recordings`.

## Безопасность

- Все админ-маршруты под аутентификацией; лог-форма и POST-эндпоинты защищены **CSRF-токеном** (`_csrf` в форме или заголовке `X-CSRF-Token`).
- Cookies `httpOnly` + `sameSite=lax`. В production при `PUBLIC_URL=https://...` автоматически включается `secure`.
- Пароли — bcrypt (12 раундов).
- helmet ставит security-заголовки.
- Лимиты: размер socket-сообщения (`MAX_FRAME_BYTES`), express body (`256kb`).
- Path traversal невозможен: все пути формируются сервером по числовым ID из БД, при отдаче файлов проверяется, что resolved-путь внутри `RECORDINGS_DIR`.
- Rate limit per-participant на отправку кадров (минимум `capture_interval / 2`).
- Back-pressure: если сервер не успевает писать кадры, новые от того же участника дропаются (а не накапливаются).
- session.regenerate() после логина (защита от session fixation).
- safeNext() предотвращает open redirect через `?next=...`.
- zod-валидация ввода участника (имя: 1..120 chars, без управляющих символов).

## Ограничения

- Захват экрана через `getDisplayMedia` поддерживается всеми современными десктоп-браузерами (Chrome, Firefox, Edge, Safari 13+). Mobile в большинстве браузеров не поддерживает screen capture.
- Длинные пропуски связи в видео сжимаются до `VIDEO_MAX_GAP_SECONDS`. Реальная длительность пропуска видна на таймлайне (hover-tooltip).
- Хранилище — обычная файловая система. Бэкап/репликация — задача внешнего слоя.

## Лицензия

MIT
