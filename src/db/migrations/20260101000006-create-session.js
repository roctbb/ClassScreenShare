'use strict';

// Таблица для connect-pg-simple. Стандартная схема из официального README:
// https://github.com/voxpelli/node-connect-pg-simple/blob/master/table.sql
// Создаём явно, чтобы миграции были источником истины и connect-pg-simple
// не пытался создать таблицу при первом запросе (createTableIfMissing: false).

module.exports = {
    async up(qi) {
        await qi.sequelize.query(`
            CREATE TABLE IF NOT EXISTS "session" (
                "sid"    VARCHAR NOT NULL COLLATE "default",
                "sess"   JSON     NOT NULL,
                "expire" TIMESTAMP(6) NOT NULL
            ) WITH (OIDS=FALSE);
        `);
        await qi.sequelize.query(`
            ALTER TABLE "session"
            ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
        `);
        await qi.sequelize.query(`
            CREATE INDEX "IDX_session_expire" ON "session" ("expire");
        `);
    },

    async down(qi) {
        await qi.sequelize.query('DROP TABLE IF EXISTS "session"');
    },
};
