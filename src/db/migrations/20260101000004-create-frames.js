'use strict';

module.exports = {
    async up(qi, DataTypes) {
        await qi.createTable('frames', {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true,
            },
            participant_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: 'participants', key: 'id' },
                onDelete: 'CASCADE',
                onUpdate: 'CASCADE',
            },
            // Unix timestamp в миллисекундах. Совместимо с Date.now().
            // Тип BIGINT — Date.now() даёт ~13-значное число, INTEGER не хватит.
            ts: {
                type: DataTypes.BIGINT,
                allowNull: false,
            },
            // Относительный путь от RECORDINGS_DIR.
            // Пример: exam_42/participant_137/frames/1700000000000.webp
            file_path: {
                type: DataTypes.STRING(512),
                allowNull: false,
            },
            size_bytes: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            created_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.literal('CURRENT_TIMESTAMP'),
            },
        });

        // Главный индекс для построения таймлайна и слайдшоу:
        // выборка кадров одного участника по диапазону времени.
        await qi.addIndex('frames', {
            fields: ['participant_id', 'ts'],
            name: 'frames_participant_ts_idx',
        });
    },

    async down(qi) {
        await qi.dropTable('frames');
    },
};
