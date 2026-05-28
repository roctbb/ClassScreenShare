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
    const copyInviteBtn = document.getElementById('copy-invite-btn');
    const copyInviteFeedback = document.getElementById('copy-invite-feedback');

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
        const row = document.querySelector(`tr[data-pid="${participantId}"]`);
        if (row) {
            row.dataset.recordingStatus = status || '';
        }
        const cell = document.querySelector(`tr[data-pid="${participantId}"] .rec-status`);
        if (cell) {
            cell.innerHTML = renderStatus(status, error);
        }
        const action = document.querySelector(`tr[data-pid="${participantId}"] .rec-action`);
        if (action) {
            action.innerHTML = renderAction(status, participantId);
        }
        refreshExamSummary();
    });

    socket.on('recording:progress', ({ participantId, percent }) => {
        const row = document.querySelector(`tr[data-pid="${participantId}"]`);
        if (row) {
            row.dataset.recordingStatus = 'running';
        }
        const cell = document.querySelector(`tr[data-pid="${participantId}"] .rec-status`);
        if (cell) {
            cell.innerHTML = `<span class="badge badge-draft">конвертируется ${percent}%</span>`;
        }
        refreshExamSummary();
    });

    if (copyInviteBtn) {
        copyInviteBtn.addEventListener('click', () => {
            copyInvite().then((ok) => {
                if (!copyInviteFeedback) return;
                copyInviteFeedback.textContent = ok
                    ? 'Ссылка скопирована.'
                    : 'Не удалось скопировать.';
                copyInviteFeedback.classList.toggle('copy-feedback-error', !ok);
                setTimeout(() => {
                    copyInviteFeedback.textContent = '';
                    copyInviteFeedback.classList.remove('copy-feedback-error');
                }, 2500);
            });
        });
    }

    function copyInvite() {
        const el = document.getElementById('invite-link');
        if (!el) return Promise.resolve(false);
        el.select();
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(el.value).then(
                () => true,
                () => fallbackCopy()
            );
        }
        return Promise.resolve(fallbackCopy());
    }

    function fallbackCopy() {
        try {
            return document.execCommand('copy');
        } catch {
            return false;
        }
    }

    function refreshExamSummary() {
        const rows = Array.from(document.querySelectorAll('tr[data-pid]'));
        const ready = rows.filter((row) => row.dataset.recordingStatus === 'done').length;
        const converting = rows.filter((row) =>
            ['pending', 'running'].includes(row.dataset.recordingStatus)
        ).length;
        const failed = rows.filter((row) => row.dataset.recordingStatus === 'failed').length;
        setText('summary-video-ready', ready);
        setText('summary-video-converting', converting);
        setText('summary-video-failed', failed);
        document.querySelector('.summary-danger')?.classList.toggle('hidden', failed === 0);
    }

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(value);
    }

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
            <form method="post" action="/admin/exams/${cfg.examId}/participants/${pid}/convert" class="inline-action-form">
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
