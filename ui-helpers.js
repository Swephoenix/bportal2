(function (global) {
    function pad(value) {
        return String(value).padStart(2, '0');
    }

    function getDefaultOrderDeadline(baseDate = new Date()) {
        const date = new Date(baseDate);
        date.setDate(date.getDate() + 1);
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function shouldShowProposalUploadButton(order, currentUser) {
        if (!order || !currentUser) return false;
        if (currentUser.role !== 'graphics') return false;
        return order.status !== 'Avklarad';
    }

    const api = { getDefaultOrderDeadline, shouldShowProposalUploadButton };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    global.BportalUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
