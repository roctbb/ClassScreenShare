'use strict';

module.exports = {
    async up(qi, DataTypes) {
        await qi.createTable('recordings', {
            id: {
                type: DataTypes.INTEGER,
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
            file_path: {
                // Относительный путь от RECORDINGS_DIR. Пример:
                // exam_42/participant_137/recording.mp4
                type: DataTypes.STRING(512),
                allowNull: true,
            },
            format: {
                type: DataTypes.STRING(16),
                allowNull: true,
            },
            fps: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            duration_ms: {
                // Реальная длительность результирующего видео (с обрезкой gaps).
                type: DataTypes.BIGINT,
                allowNull: true,
            },
            size_bytes: {
                type: DataTypes.BIGINT,
                allowNull: true,
            },
            status: {
                // pending | running | done | failed
                type: DataTypes.STRING(16),
                allowNull: false,
                defaultValue: 'pending',
            },
            error_message: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            started_at: {
                type: DataTypes.DATE,
                allowNull: true,
            },
            finished_at: {
                type: DataTypes.DATE,
                allowNull: true,
            },
            created_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.literal('CURRENT_TIMESTAMP'),
            },
            updated_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.literal('CURRENT_TIMESTAMP'),
            },
        });

        // На участника может быть только одна запись (последняя).
        // Если перезапускают конвертацию — обновляем существующую.
        await qi.addIndex('recordings', {
            fields: ['participant_id'],
            unique: true,
            name: 'recordings_participant_id_uq',
        });
        await qi.addIndex('recordings', {
            fields: ['status'],
            name: 'recordings_status_idx',
        });
    },

    async down(qi) {
        await qi.dropTable('recordings');
    },
};
