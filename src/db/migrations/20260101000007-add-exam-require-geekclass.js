'use strict';

module.exports = {
    async up(qi, DataTypes) {
        const table = await qi.describeTable('exams');
        if (table.require_geekclass) return;
        await qi.addColumn('exams', 'require_geekclass', {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
    },

    async down(qi) {
        const table = await qi.describeTable('exams');
        if (!table.require_geekclass) return;
        await qi.removeColumn('exams', 'require_geekclass');
    },
};
