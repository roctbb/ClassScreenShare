/* eslint-env browser */
/**
 * Клиент админ-страницы экзамена.
 * Подписывается на /viewer namespace и обновляет в реальном времени:
 *   - таблицу участников (новые/обновление кадров)
 *   - бейдж статуса записи (recording:status)
 *   - кнопки конвертации
 *   - сводные счётчики в инфополосе
 */
(function () {
    'use strict';

    const cfg = window.__EXAM_PAGE__;
    if (!cfg || !cfg.examId) return;
    const copyInviteBtn = document.getElementById('copy-invite-btn');
    const copyInviteFeedback = document.getElementById('copy-invite-feedback');
    const tbody = document.getElementById('participants-tbody');

    const socket = io('/viewer', {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        withCredentials: true,
    });

    socket.on('connect', () => {
        socket.emit('subscribe', { examId: cfg.examId }, (resp) => {
            if (!resp || !resp.ok) return;
            // Синхронизируем таблицу с текущим списком participants — добавляем новых.
            if (Array.isArray(resp.participants)) {
                for (const p of resp.participants) {
                    ensureRow(p);
                }
                refreshSummary();
            }
        });
    });

    socket.on('participant:join', ({ participantId, name }) => {
        ensureRow({ id: participantId, name });
        refreshSummary();
    });

    socket.on('frame', ({ participantId, ts }) => {
        const row = document.querySelector(`tr[data-pid="${participantId}"]`);
        if (!row) return;
        // Инкрементим счётчик кадров.
        const current = Number(row.dataset.frameCount || 0) + 1;
        row.dataset.frameCount = current;
        const cnt = row.querySelector('.cell-num');
        if (cnt) cnt.textContent = String(current);
        // Обновляем время последнего кадра в meta.
        const meta = row.querySelector('.participant-meta');
        if (meta) {
            const joinedTime = meta.dataset.joinedTime || '';
            const t = new Date(ts).toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
            });
            meta.textContent = joinedTime ? `${joinedTime} · ${t}` : t;
            meta.dataset.joinedTime = joinedTime;
        }
    });

    socket.on('recording:status', ({ participantId, status, error }) => {
        const row = document.querySelector(`tr[data-pid="${participantId}"]`);
        if (row) row.dataset.recordingStatus = status || '';
        const cell = document.querySelector(`tr[data-pid="${participantId}"] .rec-status`);
        if (cell) cell.innerHTML = renderStatus(status, error);
        const action = document.querySelector(`tr[data-pid="${participantId}"] .rec-action`);
        if (action) action.innerHTML = renderAction(status, participantId);
        refreshSummary();
    });

    socket.on('recording:progress', ({ participantId, percent }) => {
        const row = document.querySelector(`tr[data-pid="${participantId}"]`);
        if (row) row.dataset.recordingStatus = 'running';
        const cell = document.querySelector(`tr[data-pid="${participantId}"] .rec-status`);
        if (cell) {
            cell.innerHTML = `<span class="badge badge-draft"><i class="fas fa-spinner fa-spin"></i> ${percent}%</span>`;
        }
        refreshSummary();
    });

    if (copyInviteBtn) {
        copyInviteBtn.addEventListener('click', () => {
            copyInvite().then((ok) => {
                if (!copyInviteFeedback) return;
                copyInviteFeedback.textContent = ok ? 'Скопировано' : 'Не удалось';
                copyInviteFeedback.classList.toggle('copy-feedback-error', !ok);
                setTimeout(() => {
                    copyInviteFeedback.textContent = '';
                    copyInviteFeedback.classList.remove('copy-feedback-error');
                }, 2000);
            });
        });
    }

    function ensureRow(p) {
        if (!tbody) return;
        const pid = Number(p.id);
        const existing = document.querySelector(`tr[data-pid="${pid}"]`);
        if (existing) return existing;

        const tr = document.createElement('tr');
        tr.dataset.pid = String(pid);
        tr.dataset.frameCount = '0';
        tr.dataset.recordingStatus = '';
        const joinedTime = new Date().toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
        });
        tr.innerHTML = `
            <td>
                <div class="participant-name-cell">
                    <span>${escapeHtml(p.name || '?')}</span>
                    <small class="muted participant-meta" data-joined-time="${joinedTime}">${joinedTime}</small>
                </div>
            </td>
            <td class="cell-num">0</td>
            <td class="muted">—</td>
            <td class="rec-status"><span class="muted">—</span></td>
            <td class="table-actions">
                <span class="rec-action"></span>
                <a class="btn btn-sm btn-secondary btn-icon"
                    href="/admin/exams/${cfg.examId}/participants/${pid}"
                    title="Открыть запись участника"><i class="fas fa-arrow-right"></i></a>
            </td>
        `;
        tbody.appendChild(tr);

        // Удаляем "Пока никто не присоединился" placeholder если был.
        const emptyMsg = document.querySelector('.card .muted');
        if (emptyMsg && emptyMsg.textContent.includes('Пока никто')) emptyMsg.remove();

        // Обновляем счётчик в заголовке.
        const heading = document.querySelector('.card-heading h2 .muted');
        if (heading) {
            const count = document.querySelectorAll('tr[data-pid]').length;
            heading.textContent = `(${count})`;
        }

        return tr;
    }

    function refreshSummary() {
        const rows = Array.from(document.querySelectorAll('tr[data-pid]'));
        const ready = rows.filter((row) => row.dataset.recordingStatus === 'done').length;
        const converting = rows.filter((row) =>
            ['pending', 'running'].includes(row.dataset.recordingStatus)
        ).length;
        const failed = rows.filter((row) => row.dataset.recordingStatus === 'failed').length;
        const totalFrames = rows.reduce(
            (sum, r) => sum + Number(r.dataset.frameCount || 0),
            0
        );

        setText('summary-participants', rows.length);
        setText('summary-frames', totalFrames);
        setText('summary-video-ready', ready);

        const convertingEl = document.getElementById('summary-video-converting');
        if (convertingEl) {
            if (converting > 0) {
                convertingEl.classList.remove('hidden');
                convertingEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${converting}`;
            } else {
                convertingEl.classList.add('hidden');
                convertingEl.innerHTML = '';
            }
        }

        const failedEl = document.getElementById('summary-video-failed');
        const failedWrap = failedEl ? failedEl.closest('.summary-danger') : null;
        if (failedEl) failedEl.textContent = String(failed);
        if (failedWrap) failedWrap.classList.toggle('hidden', failed === 0);
    }

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(value);
    }

    function renderStatus(status, error) {
        if (status === 'done')
            return '<span class="badge badge-active"><i class="fas fa-check"></i> готово</span>';
        if (status === 'pending' || status === 'running')
            return '<span class="badge badge-draft"><i class="fas fa-spinner fa-spin"></i> конв.</span>';
        if (status === 'failed')
            return `<span class="badge badge-finished" title="${escapeAttr(error || '')}"><i class="fas fa-xmark"></i> ошибка</span>`;
        return '<span class="muted">—</span>';
    }

    function renderAction(status, pid) {
        if (status === 'pending' || status === 'running') return '';
        const title = status === 'done' ? 'Переконвертировать' : 'Конвертировать в видео';
        return `
            <form method="post" action="/admin/exams/${cfg.examId}/participants/${pid}/convert" class="inline-action-form">
                <input type="hidden" name="_csrf" value="${cfg.csrf}">
                <button type="submit" class="btn btn-sm btn-secondary btn-icon" title="${title}"><i class="fas fa-film"></i></button>
            </form>
        `;
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

    function escapeAttr(s) {
        return String(s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }
    function escapeHtml(s) {
        return String(s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }
})();
