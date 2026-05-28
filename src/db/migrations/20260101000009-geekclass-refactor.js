'use strict';

module.exports = {
    async up(qi, DataTypes) {
        // 1. Добавить geekclass_id в participants для дедупликации по GeekClass-пользователю.
        await qi.addColumn('participants', 'geekclass_id', {
            type: DataTypes.STRING(128),
            allowNull: true,
        });
        // Уникальный индекс: один участник GeekClass — одна запись на экзамен.
        await qi.sequelize.query(`
            CREATE UNIQUE INDEX participants_exam_geekclass_uq
            ON participants (exam_id, geekclass_id)
            WHERE geekclass_id IS NOT NULL
        `);

        // 2. require_geekclass больше не нужен — всегда GeekClass.
        await qi.removeColumn('exams', 'require_geekclass');
    },

    async down(qi, DataTypes) {
        await qi.removeColumn('participants', 'geekclass_id');
        await qi.sequelize.query('DROP INDEX IF EXISTS participants_exam_geekclass_uq');
        await qi.addColumn('exams', 'require_geekclass', {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
    },
};
