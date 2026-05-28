'use strict';

module.exports = {
    async up(qi, DataTypes) {
        await qi.createTable('exams', {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true,
            },
            name: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            code: {
                // Короткий код для инвайт-ссылки. 8 символов.
                type: DataTypes.STRING(16),
                allowNull: false,
            },
            status: {
                // draft | active | finished
                type: DataTypes.STRING(16),
                allowNull: false,
                defaultValue: 'draft',
            },
            created_by: {
                type: DataTypes.INTEGER,
                allowNull: true,
                references: { model: 'users', key: 'id' },
                onDelete: 'SET NULL',
                onUpdate: 'CASCADE',
            },
            // Снапшот настроек захвата на момент создания экзамена.
            // Если глобальные дефолты в env поменяются — это не повлияет
            // на уже созданные экзамены.
            capture_interval: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 5000,
            },
            image_quality: {
                type: DataTypes.FLOAT,
                allowNull: false,
                defaultValue: 0.8,
            },
            image_width: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 1080,
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

        await qi.addIndex('exams', {
            fields: ['code'],
            unique: true,
            name: 'exams_code_uq',
        });
        await qi.addIndex('exams', {
            fields: ['status'],
            name: 'exams_status_idx',
        });
        await qi.addIndex('exams', {
            fields: ['created_by'],
            name: 'exams_created_by_idx',
        });
    },

    async down(qi) {
        await qi.dropTable('exams');
    },
};
