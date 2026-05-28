'use strict';

module.exports = {
    async up(qi, DataTypes) {
        await qi.createTable('participant_connections', {
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
            exam_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: 'exams', key: 'id' },
                onDelete: 'CASCADE',
                onUpdate: 'CASCADE',
            },
            socket_id: {
                type: DataTypes.STRING(128),
                allowNull: false,
            },
            event: {
                type: DataTypes.STRING(32),
                allowNull: false,
            },
            reason: {
                type: DataTypes.STRING(128),
                allowNull: true,
            },
            ip: {
                type: DataTypes.STRING(64),
                allowNull: true,
            },
            user_agent: {
                type: DataTypes.STRING(512),
                allowNull: true,
            },
            created_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.literal('CURRENT_TIMESTAMP'),
            },
        });

        await qi.addIndex('participant_connections', {
            fields: ['participant_id', 'created_at'],
            name: 'participant_connections_participant_time_idx',
        });
        await qi.addIndex('participant_connections', {
            fields: ['exam_id', 'created_at'],
            name: 'participant_connections_exam_time_idx',
        });
        await qi.addIndex('participant_connections', {
            fields: ['socket_id'],
            name: 'participant_connections_socket_id_idx',
        });
    },

    async down(qi) {
        await qi.dropTable('participant_connections');
    },
};
