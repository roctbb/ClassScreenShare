'use strict';

const { DataTypes, Model } = require('sequelize');

class Exam extends Model {}

const STATUS = Object.freeze({
    DRAFT: 'draft',
    ACTIVE: 'active',
    FINISHED: 'finished',
});

function init(sequelize) {
    Exam.init(
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            name: { type: DataTypes.STRING(255), allowNull: false },
            code: { type: DataTypes.STRING(16), allowNull: false },
            status: {
                type: DataTypes.STRING(16),
                allowNull: false,
                defaultValue: STATUS.DRAFT,
                validate: { isIn: [Object.values(STATUS)] },
            },
            createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
            captureInterval: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 5000,
                field: 'capture_interval',
            },
            imageQuality: {
                type: DataTypes.FLOAT,
                allowNull: false,
                defaultValue: 0.8,
                field: 'image_quality',
            },
            imageWidth: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 1080,
                field: 'image_width',
            },
            startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
            finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
        },
        {
            sequelize,
            modelName: 'Exam',
            tableName: 'exams',
            underscored: true,
        }
    );
    return Exam;
}

Exam.STATUS = STATUS;

module.exports = { Exam, init, STATUS };
