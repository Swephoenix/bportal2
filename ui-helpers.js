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
        if (source === 'ai') {
            return {
                icon: 'fa-arrow-left',
                label: 'Tillbaka till avdelningar',
                targetPage: 'select-department',
            };
        }

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

    function getUserGroups(user) {
        const values = [
            ...(Array.isArray(user && user.groups) ? user.groups : []),
            user && user.group,
        ];

        return values
            .map((group) => String(group || '').trim())
            .filter(Boolean)
            .filter((group, index, groups) => groups.indexOf(group) === index);
    }

    function shouldShowProposalUploadButton(order, currentUser) {
        if (!order || !currentUser) return false;
        
        // Allow if user is a member OR if user belongs to the order's department
        const isMember = currentUser.role === 'member';
        const belongsToDept = (currentUser.groups && currentUser.groups.includes(order.dept)) || currentUser.group === order.dept;
        
        if (!isMember && !belongsToDept) return false;
        
        return order.status !== 'Avklarad';
    }

    function canAccessOrderChat(order, currentUser) {
        if (!order || !currentUser) return false;
        if (currentUser.role === 'admin') return true;

        const orderEmail = String(order.fromEmail || order.graphicsRequest && order.graphicsRequest.customerEmail || '').trim().toLowerCase();
        const currentEmail = String(currentUser.email || '').trim().toLowerCase();
        if (orderEmail && currentEmail && orderEmail === currentEmail) return true;

        const currentGroups = getUserGroups(currentUser);
        if (currentGroups.includes(order.dept)) return true;

        const ordererName = String(order.from || '').trim().toLowerCase();
        const currentName = String(currentUser.name || '').trim().toLowerCase();
        return Boolean(ordererName && currentName && ordererName === currentName);
    }

    function shouldShowSentOrdersButton(currentUser, sentOrders) {
        if (!currentUser || !Array.isArray(sentOrders)) return false;

        const currentUsername = String(currentUser.username || '').trim().toLowerCase();

        return sentOrders.some((order) => {
            const orderUsername = String(order && order.fromUsername || '').trim().toLowerCase();
            return Boolean(currentUsername && orderUsername && currentUsername === orderUsername);
        });
    }

    function shouldShowIncomingOrdersButton(currentUser, incomingOrders) {
        if (!currentUser || !Array.isArray(incomingOrders)) return false;
        return getUserGroups(currentUser).length > 0 || incomingOrders.length > 0;
    }

    function getDepartmentOrderButtonLabel(department) {
        const name = String(department || '').trim();
        return `Avdelningsbeställningar (${name})`;
    }

    async function loadAdminUsersSequence(actions) {
        const {
            showPage,
            resetExpanded,
            loadDepartments,
            populateGroupSelect,
            cancelEdit,
            loadUsers,
            renderUsers,
            onError,
        } = actions || {};

        if (typeof showPage === 'function') showPage('admin-users');
        if (typeof resetExpanded === 'function') resetExpanded();

        try {
            if (typeof loadDepartments === 'function') await loadDepartments();
        } catch (error) {
            if (typeof onError === 'function') onError(error, 'departments');
        }

        if (typeof populateGroupSelect === 'function') populateGroupSelect();
        if (typeof cancelEdit === 'function') cancelEdit();

        try {
            if (typeof loadUsers === 'function') await loadUsers();
        } catch (error) {
            if (typeof onError === 'function') onError(error, 'users');
        }

        if (typeof renderUsers === 'function') renderUsers();
    }

    const api = {
        canAccessOrderChat,
        getDefaultOrderDeadline,
        getDepartmentOrderButtonLabel,
        getOrderFormBackConfig,
        loadAdminUsersSequence,
        shouldShowIncomingOrdersButton,
        shouldShowSentOrdersButton,
        shouldShowProposalUploadButton,
        suggestDepartmentFromMessage,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    global.BportalUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
