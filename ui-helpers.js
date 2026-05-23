(function (global) {
    function pad(value) {
        return String(value).padStart(2, '0');
    }

    function getDefaultOrderDeadline(baseDate = new Date()) {
        const date = new Date(baseDate);
        date.setDate(date.getDate() + 1);
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function suggestDepartmentFromMessage(message) {
        const text = String(message || '').toLowerCase();

        if (!text.trim()) return null;

        if (/(bild|design|graf|affisch|banner|layout|tryck|flyer|logo|ikon)/.test(text)) {
            return 'Grafikgruppen';
        }

        if (/(dator|it|inloggning|lösenord|nätverk|wifi|system|mail|skärm|skrivare|teknik)/.test(text)) {
            return 'IT-support / Mjukvara';
        }

        if (/(val|kampanj|dörrknack|flygblad|rörelse|schema|mobilisering)/.test(text)) {
            return 'Valorganisation';
        }

        if (/(parti|stadga|motion|politik|medlems|styrelse|fråga)/.test(text)) {
            return 'Frågor om partiet';
        }

        return null;
    }

    function getOrderFormBackConfig(source) {
        if (source === 'manual') {
            return {
                icon: 'fa-arrow-left',
                label: 'Tillbaka till avdelningar',
                targetPage: 'select-department',
            };
        }

        return {
            icon: 'fa-times',
            label: 'Avbryt och gå till start',
            targetPage: 'dashboard',
        };
    }

    function shouldShowProposalUploadButton(order, currentUser) {
        if (!order || !currentUser) return false;
        if (currentUser.role !== 'graphics') return false;
        return order.status !== 'Avklarad';
    }

    const api = {
        getDefaultOrderDeadline,
        getOrderFormBackConfig,
        shouldShowProposalUploadButton,
        suggestDepartmentFromMessage,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    global.BportalUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
