const assert = require('node:assert/strict');
const { test } = require('node:test');

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

function freshApp() {
  return createApp({ state: createDefaultState() });
}

test('GET /api/health reports the backend is ready', async () => {
  const app = freshApp();
  const response = await request(app, 'GET', '/api/health');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, 'bportalen-backend');
});

test('GET /assets/b-logo.svg serves the b logo', async () => {
  const app = freshApp();
  const response = await app.inject({
    method: 'GET',
    path: '/assets/b-logo.svg',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/svg+xml; charset=utf-8');
  assert.match(response.body, /<svg/);
});

test('OPTIONS /api/orders allows browser preflight requests', async () => {
  const app = freshApp();
  const response = await app.inject({
    method: 'OPTIONS',
    path: '/api/orders',
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.match(response.headers['access-control-allow-methods'], /POST/);
});

test('POST /api/login accepts the orderer demo account', async () => {
  const app = freshApp();
  const response = await request(app, 'POST', '/api/login', {
    username: 'user',
    password: 'user',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.user, { name: 'Personal', role: 'orderer' });
});

test('POST /api/login rejects invalid credentials', async () => {
  const app = freshApp();
  const response = await request(app, 'POST', '/api/login', {
    username: 'user',
    password: 'wrong',
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, 'invalid_credentials');
});

test('POST /api/orders stores a new order and GET /api/orders returns it first', async () => {
  const app = freshApp();
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

test('POST /api/orders stores dates in yyyy-mm-dd format', async () => {
  const app = freshApp();
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Skapa en banner till kampanjen.',
    deadline: '2026-06-01',
    dept: 'Grafiska produktionsgruppen',
  });

  assert.equal(created.statusCode, 201);
  assert.match(created.body.order.createdAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(created.body.order.deadline, '2026-06-01');
});

test('POST /api/orders rejects deadlines outside yyyy-mm-dd format', async () => {
  const app = freshApp();
  const response = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Skapa en banner till kampanjen.',
    deadline: '2026-6-1',
    dept: 'Grafiska produktionsgruppen',
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'invalid_order');
  assert.deepEqual(response.body.details, ['deadline_invalid']);
});

test('GET /api/orders can filter orders by sender', async () => {
  const app = freshApp();
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
  const app = freshApp();
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
  const app = freshApp();
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
  const app = freshApp();
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
  const app = freshApp();
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
  const app = freshApp();
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
  const app = freshApp();
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

test('POST /api/ai/suggest returns an AI department suggestion for the chat harness', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            department: 'Grafiska produktionsgruppen',
            reason: 'Det handlar om en banner.',
            confidence: 0.96,
          }),
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Vi behöver en banner till kampanjen.',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'Grafiska produktionsgruppen');
  assert.equal(response.body.suggestion.reason, 'Det handlar om en banner.');
  assert.equal(response.body.availableDepartments.includes('Grafiska produktionsgruppen'), true);
});

test('POST /api/ai/suggest forwards previous chat messages to Ollama', async () => {
  let capturedBody = null;
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              department: 'IT-support',
              reason: 'Tidigare meddelanden nämner dator och inloggning.',
              confidence: 0.88,
            }),
          },
        }),
      };
    },
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    messages: [
      { role: 'user', content: 'Först behöver jag hjälp med kampanjen.' },
      { role: 'assistant', content: 'Okej, berätta mer.' },
      { role: 'user', content: 'Nu gäller det inloggningen på datorn.' },
    ],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(capturedBody.messages.some((message) => message.content.includes('kampanjen')), true);
  assert.equal(capturedBody.messages.some((message) => message.content.includes('inloggningen på datorn')), true);
  assert.equal(capturedBody.options.num_ctx, 30000);
  assert.equal(capturedBody.format, undefined);
  assert.equal(response.body.suggestion.department, 'IT-support');
});

test('POST /api/ai/suggest uses a free-chat prompt with recommendation commands', async () => {
  let capturedBody = null;
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              department: 'Grafiska produktionsgruppen',
              reason: 'Det gäller en grafisk beställning.',
              confidence: 0.91,
            }),
          },
        }),
      };
    },
  });

  await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Vi behöver en banner till kampanjen.',
  });

  assert.match(capturedBody.messages[0].content, /fri chattassistent/i);
  assert.match(capturedBody.messages[0].content, /hjälpsam människa/i);
  assert.match(capturedBody.messages[0].content, /huvudmål/i);
  assert.match(capturedBody.messages[0].content, /kommando-rad/i);
  assert.match(capturedBody.messages[0].content, /exempel/i);
  assert.match(capturedBody.messages[0].content, /banner/i);
});

test('POST /api/ai/suggest can return a friendly reply without a department', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: 'Jag mår bra, tack! Hur kan jag hjälpa dig i dag?',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Hur mår du?',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion, null);
  assert.equal(response.body.reply, 'Jag mår bra, tack! Hur kan jag hjälpa dig i dag?');
});

test('POST /api/ai/suggest allows casual conversation in the system prompt', async () => {
  let capturedBody = null;
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          message: {
            content: 'Jag mår bra och är redo att hjälpa dig.',
          },
        }),
      };
    },
  });

  await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Hur mår du?',
  });

  assert.ok(capturedBody && Array.isArray(capturedBody.messages));
  assert.ok(capturedBody.messages[0].content.includes('vardaglig fråga'));
  assert.ok(capturedBody.messages[0].content.includes('småpratar'));
});

test('POST /api/ai/suggest extracts a department command from free-form chat', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: 'Det låter som en grafisk beställning.\n[[recommend department="Grafiska produktionsgruppen" confidence="0.91" reason="Det gäller en banner."]]',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Vi behöver en banner till kampanjen.',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'Grafiska produktionsgruppen');
  assert.equal(response.body.suggestion.reason, 'Det gäller en banner.');
  assert.equal(response.body.reply, 'Det låter som en grafisk beställning.');
});

test('POST /api/ai/suggest accepts a slightly malformed department command at the end', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: 'Jag tror att det här är en grafisk sak.\n[[recommend department="Grafiska produktionsgruppen" confidence="0.85" reason="Det gäller en bild."]',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Jag skulle vilja beställa någon bild',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'Grafiska produktionsgruppen');
  assert.equal(response.body.reply, 'Jag tror att det här är en grafisk sak.');
});

test('POST /api/ai/suggest returns no suggestion if Ollama fails', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => {
      throw new Error('ollama unavailable');
    },
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Vi behöver en flyer och en banner till kampanjen.',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion, null);
  assert.equal(response.body.reply, undefined);
  assert.equal(response.body.error, 'ollama unavailable');
});
