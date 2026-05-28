'use strict';

const { EventEmitter } = require('events');

/**
 * Простой in-process event-bus для синхронизации модулей без циклических
 * зависимостей. Используется publisher namespace'ом для уведомления viewer
 * namespace'а о новых кадрах и о подключении/отключении участников.
 *
 * События:
 *   frame    { examId, participantId, ts, dataUrl }  — новый кадр пришёл от участника
 *   join     { examId, participantId, name }         — участник присоединился
 *   leave    { examId, participantId }               — участник отключился
 *   stale    { examId, participantId, silentMs }     — участник перестал слать кадры
 */
class Bus extends EventEmitter {}

const bus = new Bus();
bus.setMaxListeners(50);

module.exports = bus;
