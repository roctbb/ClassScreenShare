import { execSync } from 'child_process';

/**
 * Глобальный setup vitest: поднимаем postgres в Docker, прогоняем миграции.
 * Контейнер cs-pg-test остаётся между тестами; teardown останавливает.
 */
const CONTAINER = 'cs-pg-test';
const PORT = '5433';

export async function setup() {
    // Если контейнер уже есть — переиспользуем (быстрее).
    let running = false;
    try {
        const out = execSync(`docker ps --format '{{.Names}}'`, { encoding: 'utf8' });
        running = out.split('\n').includes(CONTAINER);
    } catch {
        // Docker недоступен — тесты, требующие БД, упадут с понятной ошибкой.
        return;
    }
    if (!running) {
        // Если есть остановленный — удалим.
        try {
            execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' });
        } catch {
            // ignore
        }
        execSync(
            `docker run -d --name ${CONTAINER} -p ${PORT}:5432 ` +
                `-e POSTGRES_DB=classscreenshare ` +
                `-e POSTGRES_USER=classscreenshare ` +
                `-e POSTGRES_PASSWORD=classscreenshare ` +
                `postgres:16-alpine`,
            { stdio: 'ignore' }
        );
        // Ждём готовности.
        for (let i = 0; i < 30; i++) {
            try {
                execSync(
                    `docker exec ${CONTAINER} pg_isready -U classscreenshare -d classscreenshare`,
                    { stdio: 'ignore' }
                );
                break;
            } catch {
                await new Promise((r) => setTimeout(r, 500));
            }
        }
    }

    // Прогоняем миграции с чистой БД (на всякий случай drop + recreate схемы).
    execSync(
        `docker exec ${CONTAINER} psql -U classscreenshare -d classscreenshare -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`,
        { stdio: 'ignore' }
    );
}

export async function teardown() {
    if (!process.env.KEEP_TEST_DB) {
        try {
            execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' });
        } catch {
            // ignore
        }
    }
}
