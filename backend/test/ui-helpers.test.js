const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  getDefaultOrderDeadline,
  getOrderFormBackConfig,
  canAccessOrderChat,
  shouldShowIncomingOrdersButton,
  shouldShowSentOrdersButton,
  shouldShowProposalUploadButton,
  suggestDepartmentFromMessage,
} = require('../../ui-helpers');

test('shouldShowProposalUploadButton hides completed orders and shows reopened ones for member', () => {
  const memberUser = { role: 'member' };

  assert.equal(
    shouldShowProposalUploadButton({ status: 'Avklarad' }, memberUser),
    false,
  );
  assert.equal(
    shouldShowProposalUploadButton({ status: 'Återöppnad' }, memberUser),
    true,
  );
});

test('canAccessOrderChat allows the order owner, department members and admins', () => {
  const order = {
    dept: 'Grafikgruppen',
    from: 'Anders Jansson',
    fromEmail: 'personal@example.com',
  };

  assert.equal(canAccessOrderChat(order, { role: 'member', email: 'personal@example.com' }), true);
  assert.equal(canAccessOrderChat(order, { role: 'member', email: 'grafikgruppen@example.com', groups: ['Grafikgruppen'] }), true);
  assert.equal(canAccessOrderChat(order, { role: 'admin', email: 'admin@example.com' }), true);
  assert.equal(canAccessOrderChat(order, { role: 'member', email: 'lena.karlsson@example.com', groups: ['Frågor om partiet'] }), false);
});

test('shouldShowSentOrdersButton only shows the button when the user has sent orders', () => {
  const user = { username: 'user', name: 'Anders Jansson', email: 'personal@example.com' };

  assert.equal(
    shouldShowSentOrdersButton(user, [
      { fromUsername: 'user2', from: 'Anna Olsson', fromEmail: 'grafikgruppen@example.com' },
    ]),
    false,
  );

  assert.equal(
    shouldShowSentOrdersButton(user, [
      { fromUsername: 'user', from: 'Anders Jansson', fromEmail: 'personal@example.com' },
    ]),
    true,
  );

  assert.equal(
    shouldShowSentOrdersButton(user, [
      { fromUsername: 'someone-else', from: 'Någon annan', fromEmail: 'personal@example.com' },
    ]),
    false,
  );
});

test('shouldShowIncomingOrdersButton only shows the button when incoming orders exist', () => {
  const user = { role: 'member', groups: ['Grafikgruppen'] };

  assert.equal(shouldShowIncomingOrdersButton(user, []), false);
  assert.equal(shouldShowIncomingOrdersButton(user, [{ id: '1', dept: 'Grafikgruppen' }]), true);
});

test('getDefaultOrderDeadline returns tomorrow in yyyy-mm-dd format', () => {
  const baseDate = new Date('2026-05-20T12:00:00');

  assert.equal(getDefaultOrderDeadline(baseDate), '2026-05-21');
});

test('suggestDepartmentFromMessage routes graphics requests to the graphics group', () => {
  assert.equal(
    suggestDepartmentFromMessage('Vi behöver en affisch och en banner till kampanjen.'),
    'Grafikgruppen',
  );
});

test('getOrderFormBackConfig returns department selection for manual orders', () => {
  assert.deepEqual(getOrderFormBackConfig('manual'), {
    icon: 'fa-arrow-left',
    label: 'Tillbaka till avdelningar',
    targetPage: 'select-department',
  });
});

test('getOrderFormBackConfig returns department selection for AI suggested orders', () => {
  assert.deepEqual(getOrderFormBackConfig('ai'), {
    icon: 'fa-arrow-left',
    label: 'Tillbaka till avdelningar',
    targetPage: 'select-department',
  });
});
