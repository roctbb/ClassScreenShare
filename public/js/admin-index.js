/* eslint-env browser */
(function () {
    'use strict';

    const rows = Array.from(document.querySelectorAll('[data-exam-row]'));
    if (rows.length === 0) return;

    const searchInput = document.getElementById('exam-search-input');
    const statusFilter = document.getElementById('exam-status-filter');
    const authFilter = document.getElementById('exam-auth-filter');
    const summary = document.getElementById('exam-list-summary');
    const emptyRow = document.getElementById('exam-list-empty');

    function normalized(value) {
        return String(value || '')
            .trim()
            .toLowerCase();
    }

    function matches(row) {
        const query = normalized(searchInput?.value);
        const status = statusFilter?.value || 'all';
        const auth = authFilter?.value || 'all';
        const haystack = `${row.dataset.name || ''} ${row.dataset.code || ''}`.toLowerCase();

        if (query && !haystack.includes(query)) return false;
        if (status !== 'all' && row.dataset.status !== status) return false;
        if (auth !== 'all' && row.dataset.auth !== auth) return false;
        return true;
    }

    function updateSummary(visible) {
        if (!summary) return;
        const parts = [];
        if (searchInput?.value.trim()) parts.push(`поиск: «${searchInput.value.trim()}»`);
        if (statusFilter?.value && statusFilter.value !== 'all') {
            parts.push(`статус: ${statusFilter.options[statusFilter.selectedIndex].text}`);
        }
        if (authFilter?.value && authFilter.value !== 'all') {
            parts.push(`вход: ${authFilter.options[authFilter.selectedIndex].text}`);
        }
        const suffix = parts.length > 0 ? `; ${parts.join(', ')}` : '';
        summary.textContent = `Показано ${visible} из ${rows.length}${suffix}.`;
    }

    function applyFilters() {
        let visible = 0;
        rows.forEach((row) => {
            const show = matches(row);
            row.classList.toggle('hidden', !show);
            if (show) visible += 1;
        });
        emptyRow?.classList.toggle('hidden', visible > 0);
        updateSummary(visible);
    }

    searchInput?.addEventListener('input', applyFilters);
    statusFilter?.addEventListener('change', applyFilters);
    authFilter?.addEventListener('change', applyFilters);
    applyFilters();
})();
