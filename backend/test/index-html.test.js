const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const indexHtml = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');

test('hideAll hides the embedded lagret page', () => {
  const hideAllMatch = indexHtml.match(/function hideAll\(\) \{[\s\S]*?\n\s*\}/);

  assert.ok(hideAllMatch, 'hideAll function should exist');
  assert.match(hideAllMatch[0], /'lagret-page'/);
});

test('dashboard department order buttons do not depend on existing orders', () => {
  const start = indexHtml.indexOf('async function showDashboard(options = {})');
  const end = indexHtml.indexOf('function roleLabel', start);

  assert.notEqual(start, -1, 'showDashboard function should exist');
  assert.ok(end > start, 'showDashboard function should end before roleLabel');
  const showDashboardSource = indexHtml.slice(start, end);

  assert.match(showDashboardSource, /getCurrentUserGroups\(\)/);
  assert.match(showDashboardSource, /getDepartmentOrderButtonLabel/);
  assert.doesNotMatch(showDashboardSource, /loadIncomingOrdersForMenu/);
});

test('department person saves refresh the active user session', () => {
  const start = indexHtml.indexOf('async function saveDepartmentPerson(user, overrides = {})');
  const end = indexHtml.indexOf('function renderDepartmentPeople', start);

  assert.notEqual(start, -1, 'saveDepartmentPerson function should exist');
  assert.ok(end > start, 'saveDepartmentPerson should end before renderDepartmentPeople');
  const saveDepartmentPersonSource = indexHtml.slice(start, end);

  assert.match(saveDepartmentPersonSource, /currentUser\s*&&\s*currentUser\.username\s*===\s*user\.username/);
  assert.match(saveDepartmentPersonSource, /saveCurrentUser\(currentUser,\s*impersonatedBy/);
});
