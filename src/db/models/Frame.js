'use strict';

const { DataTypes, Model } = require('sequelize');

class Frame extends Model {}

function init(sequelize) {
    Frame.init(
        {
            id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
            participantId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                field: 'participant_id',
            },
            // Date.now() приходит JS-числом, но BIGINT возвращается строкой.
            // Используем геттер-сеттер, чтобы внутри JS работать с числом.
            ts: {
                type: DataTypes.BIGINT,
                allowNull: false,
                get() {
                    const v = this.getDataValue('ts');
                    return v == null ? null : Number(v);
                },
            },
            filePath: { type: DataTypes.STRING(512), allowNull: false, field: 'file_path' },
            sizeBytes: { type: DataTypes.INTEGER, allowNull: false, field: 'size_bytes' },
        },
        {
            sequelize,
            modelName: 'Frame',
            tableName: 'frames',
            underscored: true,
            // У frames только created_at, без updated_at.
            timestamps: true,
            updatedAt: false,
        }
    );
    return Frame;
}

module.exports = { Frame, init };
