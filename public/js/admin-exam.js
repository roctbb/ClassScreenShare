/* eslint-env browser */
/**
 * Клиент админ-страницы экзамена.
 * Подписывается на /viewer namespace и обновляет в реальном времени:
 *   - бейдж статуса записи (recording:status)
 *   - кнопки конвертации
 * (Live-сетка участников живёт на отдельной странице /admin/exams/:id/live)
 */
(function () {
    'use strict';

    const cfg = window.__EXAM_PAGE__;
    if (!cfg || !cfg.examId) return;

    const socket = io('/viewer', {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        withCredentials: true,
    });

    socket.on('connect', () => {
        socket.emit('subscribe', { examId: cfg.examId }, () => {
            // ack игнорируем — нам нужны только push-сообщения.
        });
    });

    socket.on('recording:status', ({ participantId, status, error }) => {
        const cell = document.querySelector(`tr[data-pid="${participantId}"] .rec-status`);
        if (cell) {
            cell.innerHTML = renderStatus(status, error);
        }
        const action = document.querySelector(`tr[data-pid="${participantId}"] .rec-action`);
        if (action) {
            action.innerHTML = renderAction(status, participantId);
        }
    });

    socket.on('recording:progress', ({ participantId, percent }) => {
        const cell = document.querySelector(`tr[data-pid="${participantId}"] .rec-status`);
        if (cell) {
            cell.innerHTML = `<span class="badge badge-draft">конвертируется ${percent}%</span>`;
        }
    });

    function renderStatus(status, error) {
        if (status === 'done') return '<span class="badge badge-active">видео готово</span>';
        if (status === 'pending' || status === 'running')
            return '<span class="badge badge-draft">конвертируется…</span>';
        if (status === 'failed')
            return `<span class="badge badge-finished" title="${escapeAttr(error || '')}">ошибка</span>`;
        return '<span class="muted">—</span>';
    }

    function renderAction(status, pid) {
        if (status === 'pending' || status === 'running') return '';
        const label = status === 'done' ? 'Переконв.' : 'В видео';
        return `
            <form method="post" action="/admin/exams/${cfg.examId}/participants/${pid}/convert" style="display:inline">
                <input type="hidden" name="_csrf" value="${cfg.csrf}">
                <button type="submit" class="btn btn-sm btn-secondary">${label}</button>
            </form>
        `;
    }

    function escapeAttr(s) {
        return String(s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }
})();
