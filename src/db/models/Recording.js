'use strict';

const { DataTypes, Model } = require('sequelize');

class Recording extends Model {}

const STATUS = Object.freeze({
    PENDING: 'pending',
    RUNNING: 'running',
    DONE: 'done',
    FAILED: 'failed',
});

function init(sequelize) {
    Recording.init(
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            participantId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                field: 'participant_id',
            },
            filePath: { type: DataTypes.STRING(512), allowNull: true, field: 'file_path' },
            format: { type: DataTypes.STRING(16), allowNull: true },
            fps: { type: DataTypes.FLOAT, allowNull: true },
            durationMs: {
                type: DataTypes.BIGINT,
                allowNull: true,
                field: 'duration_ms',
                get() {
                    const v = this.getDataValue('durationMs');
                    return v == null ? null : Number(v);
                },
            },
            sizeBytes: {
                type: DataTypes.BIGINT,
                allowNull: true,
                field: 'size_bytes',
                get() {
                    const v = this.getDataValue('sizeBytes');
                    return v == null ? null : Number(v);
                },
            },
            status: {
                type: DataTypes.STRING(16),
                allowNull: false,
                defaultValue: STATUS.PENDING,
                validate: { isIn: [Object.values(STATUS)] },
            },
            errorMessage: { type: DataTypes.TEXT, allowNull: true, field: 'error_message' },
            startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
            finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
        },
        {
            sequelize,
            modelName: 'Recording',
            tableName: 'recordings',
            underscored: true,
        }
    );
    return Recording;
}

Recording.STATUS = STATUS;

module.exports = { Recording, init, STATUS };
