import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.js'],
        globals: false,
        testTimeout: 30000,
        globalSetup: ['tests/setup-db.js'],
        // DB-зависимые тесты выделены в отдельную папку tests/db/, конкурентность
        // там не нужна — все используют одну БД.
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },
    },
});
