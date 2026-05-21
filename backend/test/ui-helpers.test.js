const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  getDefaultOrderDeadline,
  shouldShowProposalUploadButton,
  suggestDepartmentFromMessage,
} = require('../../ui-helpers');

test('shouldShowProposalUploadButton hides completed orders and shows reopened ones for graphics', () => {
  const graphicsUser = { role: 'graphics' };

  assert.equal(
    shouldShowProposalUploadButton({ status: 'Avklarad' }, graphicsUser),
    false,
  );
  assert.equal(
    shouldShowProposalUploadButton({ status: 'Återöppnad' }, graphicsUser),
    true,
  );
});

test('getDefaultOrderDeadline returns tomorrow in yyyy-mm-dd format', () => {
  const baseDate = new Date('2026-05-20T12:00:00');

  assert.equal(getDefaultOrderDeadline(baseDate), '2026-05-21');
});

test('suggestDepartmentFromMessage routes graphics requests to the graphics group', () => {
  assert.equal(
    suggestDepartmentFromMessage('Vi behöver en affisch och en banner till kampanjen.'),
    'Grafiska produktionsgruppen',
  );
});
