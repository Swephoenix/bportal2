const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');

const { createApp, createDefaultState } = require('../server');

async function request(app, method, path, body) {
  const response = await app.inject({
    method,
    path,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = response.body;
  const parsed = text ? JSON.parse(text) : null;

  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: parsed,
  };
}

let app;

beforeEach(() => {
  app = createApp({ state: createDefaultState() });
});

test('GET /api/health reports the backend is ready', async () => {
  const response = await request(app, 'GET', '/api/health');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, 'bportal-backend');
});

test('OPTIONS /api/orders allows browser preflight requests', async () => {
  const response = await app.inject({
    method: 'OPTIONS',
    path: '/api/orders',
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.match(response.headers['access-control-allow-methods'], /POST/);
});

test('POST /api/login accepts the orderer demo account', async () => {
  const response = await request(app, 'POST', '/api/login', {
    username: 'user',
    password: 'user',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.user, { name: 'Personal', role: 'orderer' });
});

test('POST /api/login rejects invalid credentials', async () => {
  const response = await request(app, 'POST', '/api/login', {
    username: 'user',
    password: 'wrong',
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, 'invalid_credentials');
});

test('POST /api/orders stores a new order and GET /api/orders returns it first', async () => {
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Skapa en banner till kampanjen.',
    deadline: '2026-06-01',
    dept: 'Grafiska produktionsgruppen',
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.order.from, 'Personal');
  assert.equal(created.body.order.status, 'Ny');
  assert.ok(created.body.order.id);

  const listed = await request(app, 'GET', '/api/orders?dept=Grafiska%20produktionsgruppen');

  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.orders[0].id, created.body.order.id);
  assert.equal(listed.body.orders[0].msg, 'Skapa en banner till kampanjen.');
});

test('GET /api/orders can filter orders by sender', async () => {
  const personal = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Min skickade beställning.',
    deadline: '',
    dept: 'IT-support',
  });
  await request(app, 'POST', '/api/orders', {
    from: 'Annan användare',
    msg: 'Ska inte synas för Personal.',
    deadline: '',
    dept: 'IT-support',
  });

  const listed = await request(app, 'GET', '/api/orders?from=Personal');

  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.body.orders.map((order) => order.id), [personal.body.order.id]);
});

test('POST /api/orders stores file attachments with safe metadata', async () => {
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Använd bifogad logotyp.',
    deadline: '',
    dept: 'Grafiska produktionsgruppen',
    attachments: [
      {
        name: '../kampanj-logo.png',
        type: 'image/png',
        size: 128,
        dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      },
    ],
  });

  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.order.attachments, [
    {
      id: created.body.order.attachments[0].id,
      name: 'kampanj-logo.png',
      type: 'image/png',
      size: 128,
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
    },
  ]);
  assert.ok(created.body.order.attachments[0].id);
});

test('POST /api/orders requires a message and valid department', async () => {
  const response = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: '',
    deadline: '',
    dept: 'Ekonomi',
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'invalid_order');
  assert.deepEqual(response.body.details, ['msg_required', 'dept_invalid']);
});

test('POST /api/orders rejects too many attachments', async () => {
  const response = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'För många filer.',
    deadline: '',
    dept: 'Grafiska produktionsgruppen',
    attachments: Array.from({ length: 6 }, (_, index) => ({
      name: `fil-${index}.txt`,
      type: 'text/plain',
      size: 10,
      dataUrl: 'data:text/plain;base64,aGVq',
    })),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'invalid_order');
  assert.deepEqual(response.body.details, ['attachments_too_many']);
});

test('POST /api/orders/:id/proposals adds image proposals and puts the order on review', async () => {
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Ta fram två kampanjbilder.',
    deadline: '',
    dept: 'Grafiska produktionsgruppen',
  });

  const response = await request(app, 'POST', `/api/orders/${created.body.order.id}/proposals`, {
    from: 'Grafikgruppen',
    note: 'Här är två snabba förslag.',
    attachments: [
      {
        name: 'forslag-a.png',
        type: 'image/png',
        size: 42,
        dataUrl: 'data:image/png;base64,ZmFrZQ==',
      },
    ],
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.order.status, 'På remiss');
  assert.equal(response.body.proposal.note, 'Här är två snabba förslag.');
  assert.equal(response.body.proposal.attachments[0].name, 'forslag-a.png');
});

test('POST /api/orders/:id/review stores the orderer review and completion choice', async () => {
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Ta fram kampanjbild.',
    deadline: '',
    dept: 'Grafiska produktionsgruppen',
  });
  const proposal = await request(app, 'POST', `/api/orders/${created.body.order.id}/proposals`, {
    from: 'Grafikgruppen',
    note: 'Förslag klart.',
    attachments: [
      {
        name: 'forslag.png',
        type: 'image/png',
        size: 42,
        dataUrl: 'data:image/png;base64,ZmFrZQ==',
      },
    ],
  });

  const response = await request(app, 'POST', `/api/orders/${created.body.order.id}/review`, {
    proposalId: proposal.body.proposal.id,
    rating: 5,
    response: 'Den här fungerar.',
    completed: true,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.order.status, 'Avklarad');
  assert.deepEqual(response.body.proposal.review, {
    rating: 5,
    response: 'Den här fungerar.',
    completed: true,
    reviewedAt: response.body.proposal.review.reviewedAt,
  });
  assert.ok(response.body.proposal.review.reviewedAt);
});

test('POST /api/orders/:id/reopen lets graphics reopen a completed order', async () => {
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Ta fram kampanjbild.',
    deadline: '',
    dept: 'Grafiska produktionsgruppen',
  });
  const proposal = await request(app, 'POST', `/api/orders/${created.body.order.id}/proposals`, {
    from: 'Grafikgruppen',
    note: 'Förslag klart.',
    attachments: [
      {
        name: 'forslag.png',
        type: 'image/png',
        size: 42,
        dataUrl: 'data:image/png;base64,ZmFrZQ==',
      },
    ],
  });
  await request(app, 'POST', `/api/orders/${created.body.order.id}/review`, {
    proposalId: proposal.body.proposal.id,
    rating: 5,
    response: 'Den här fungerar.',
    completed: true,
  });

  const response = await request(app, 'POST', `/api/orders/${created.body.order.id}/reopen`, {
    note: 'Behöver göra en sista justering.',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.order.status, 'Återöppnad');
  assert.equal(response.body.order.reopenedAt, response.body.order.reopenHistory[0].reopenedAt);
  assert.deepEqual(response.body.order.reopenHistory[0].note, 'Behöver göra en sista justering.');
});
