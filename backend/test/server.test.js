const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createApp,
  createDefaultState,
  DEPARTMENTS,
  DEPARTMENT_EMAILS,
  warmOllamaModel,
  startOllamaWarmupLoop,
  abortOllamaWarmup,
} = require('../server');

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
  assert.deepEqual(response.body.departments, DEPARTMENTS);
  assert.equal(response.body.departmentEmails.Grafikgruppen, DEPARTMENT_EMAILS.Grafikgruppen);
  assert.equal(response.body.departments.includes('IT-support / Mjukvara'), true);
});

test('GET /api/ai/status reports warm when the configured model is loaded', async () => {
  const app = createApp({
    state: createDefaultState(),
    ollamaFetch: async (url) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/ps');
      return {
        ok: true,
        async json() {
          return {
            models: [
              { name: 'granite4.1:3b' },
            ],
          };
        },
      };
    },
  });

  const response = await request(app, 'GET', '/api/ai/status');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'warm');
  assert.equal(response.body.warm, true);
  assert.equal(response.body.model, 'granite4.1:3b');
  assert.deepEqual(response.body.loadedModels, ['granite4.1:3b']);
});

test('GET /api/ai/status reports cold when Ollama is reachable but the model is not loaded', async () => {
  const app = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      async json() {
        return {
          models: [
            { name: 'llama3.2:3b' },
          ],
        };
      },
    }),
  });

  const response = await request(app, 'GET', '/api/ai/status');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'cold');
  assert.equal(response.body.warm, false);
  assert.deepEqual(response.body.loadedModels, ['llama3.2:3b']);
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

test('GET /api/departments lists department names and emails', async () => {
  const app = freshApp();
  const response = await request(app, 'GET', '/api/departments');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.departments.some((department) => (
    department.name === 'Grafikgruppen' && department.email === 'grafikgruppen@example.com'
  )), true);
});

test('PUT /api/departments updates departments used by orders', async () => {
  const app = freshApp();
  const updated = await request(app, 'PUT', '/api/departments', {
    departments: [
      { name: 'Chefens avdelning', email: 'chefen@example.com' },
      { name: 'Grafikgruppen', email: 'ny-grafik@example.com' },
    ],
  });

  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.body.departments, [
    { name: 'Chefens avdelning', email: 'chefen@example.com' },
    { name: 'Grafikgruppen', email: 'ny-grafik@example.com' },
  ]);

  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Skicka till ny avdelning.',
    deadline: '',
    dept: 'Chefens avdelning',
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.order.dept, 'Chefens avdelning');
  assert.equal(created.body.order.deptEmail, 'chefen@example.com');
});

test('PUT /api/departments keeps Grafikgruppen even if it is omitted', async () => {
  const app = freshApp();
  const updated = await request(app, 'PUT', '/api/departments', {
    departments: [
      { name: 'Chefens avdelning', email: 'chefen@example.com' },
    ],
  });

  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.departments.some((department) => (
    department.name === 'Grafikgruppen' && department.email === 'grafikgruppen@example.com'
  )), true);
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
    dept: 'Grafikgruppen',
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.order.from, 'Personal');
  assert.equal(created.body.order.status, 'Ny');
  assert.equal(created.body.order.dept, 'Grafikgruppen');
  assert.equal(created.body.order.deptEmail, 'grafikgruppen@example.com');
  assert.ok(created.body.order.id);

  const listed = await request(app, 'GET', '/api/orders?dept=Grafikgruppen');

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
    dept: 'Grafikgruppen',
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
    dept: 'Grafikgruppen',
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
    dept: 'IT-support / Mjukvara',
  });
  await request(app, 'POST', '/api/orders', {
    from: 'Annan användare',
    msg: 'Ska inte synas för Personal.',
    deadline: '',
    dept: 'IT-support / Mjukvara',
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
    dept: 'Grafikgruppen',
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
    dept: 'Grafikgruppen',
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
    dept: 'Grafikgruppen',
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
    dept: 'Grafikgruppen',
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
    dept: 'Grafikgruppen',
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
          content: 'Det handlar om en banner.\n[[recommend department="Grafikgruppen" confidence="0.96" reason="Det handlar om en banner."]]',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Vi behöver en banner till kampanjen.',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'Grafikgruppen');
  assert.equal(response.body.suggestion.reason, 'Det handlar om en banner.');
  assert.equal(response.body.availableDepartments.includes('Grafikgruppen'), true);
});

test('POST /api/ai/suggest forwards previous chat messages to Ollama', async () => {
  let capturedUrl = null;
  let capturedBody = null;
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          message: {
            content: 'Tidigare meddelanden nämner dator och inloggning.\n[[recommend department="IT-support / Mjukvara" confidence="0.88" reason="Tidigare meddelanden nämner dator och inloggning."]]',
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
  assert.equal(capturedUrl, 'http://127.0.0.1:11434/api/chat');
  assert.equal(capturedBody.model, 'granite4.1:3b');
  assert.equal(capturedBody.stream, false);
  assert.equal(capturedBody.messages.some((message) => message.content.includes('kampanjen')), true);
  assert.equal(capturedBody.messages.some((message) => message.content.includes('inloggningen på datorn')), true);
  assert.equal(capturedBody.options.num_ctx, 7500);
  assert.equal(capturedBody.options.num_predict, 120);
  assert.equal(capturedBody.keep_alive, -1);
  assert.equal(capturedBody.format, undefined);
  assert.equal(response.body.suggestion.department, 'IT-support / Mjukvara');
});

test('POST /api/ai/suggest streams chunks and keeps Ollama loaded indefinitely', async () => {
  let capturedBody = null;
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('{"message":{"thinking":"Tänker "}}\n'),
    encoder.encode('{"message":{"content":"Hej "}}\n'),
    encoder.encode('{"message":{"content":"du!"}}\n'),
    encoder.encode('{"done":true}\n'),
  ];
  let chunkIndex = 0;

  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                if (chunkIndex < chunks.length) {
                  return { value: chunks[chunkIndex++], done: false };
                }

                return { done: true };
              },
            };
          },
        },
      };
    },
  });

  const response = await aiApp.inject({
    method: 'POST',
    path: '/api/ai/suggest',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: 'Hur mår du?',
      stream: true,
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(capturedBody.stream, true);
  assert.equal(capturedBody.keep_alive, -1);
  assert.equal(capturedBody.options.num_predict, 120);

  const lines = response.body.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].type, 'thinking');
  assert.equal(lines[1].type, 'delta');
  assert.equal(lines[0].content + lines[1].content + lines[2].content, 'Tänker Hej du!');
  assert.equal(lines.at(-1).type, 'final');
  assert.equal(lines.at(-1).reply, 'Hej du!');
  assert.equal(lines.at(-1).rawThinking, 'Tänker ');
  assert.equal(lines.at(-1).rawResponse, 'Hej du!');
  assert.equal(lines.at(-1).fullResponse, 'Tänker Hej du!');
});

test('warmOllamaModel sends a preload prompt that keeps the configured model loaded', async () => {
  let capturedUrl = null;
  let capturedBody = null;
  let capturedSignal = null;
  const abortController = new AbortController();

  const ok = await warmOllamaModel({
    fetchFn: async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      capturedSignal = options.signal;
      return { ok: true };
    },
    signal: abortController.signal,
  });

  assert.equal(ok, true);
  assert.equal(capturedUrl, 'http://127.0.0.1:11434/api/generate');
  assert.equal(capturedSignal, abortController.signal);
  assert.equal(capturedBody.model, 'granite4.1:3b');
  assert.equal(capturedBody.prompt, 'Svara endast med OK.');
  assert.equal(capturedBody.stream, false);
  assert.equal(capturedBody.keep_alive, -1);
  assert.equal(capturedBody.options.num_ctx, 7500);
  assert.equal(capturedBody.options.num_predict, 1);
});

test('POST /api/ai/suggest does not abort an in-flight Ollama startup warmup', async () => {
  let warmupSignal = null;
  let resolveWarmupStarted = null;
  const warmupStarted = new Promise((resolve) => {
    resolveWarmupStarted = resolve;
  });

  const timer = startOllamaWarmupLoop({
    intervalMs: 60 * 60 * 1000,
    fetchFn: async (_url, options) => {
      warmupSignal = options.signal;
      resolveWarmupStarted();
      return new Promise(() => {});
    },
  });

  try {
    await warmupStarted;

    const aiApp = createApp({
      state: createDefaultState(),
      ollamaFetch: async () => ({
        ok: true,
        json: async () => ({
          message: {
            content: 'Det hör till IT-support / Mjukvara.\n[[recommend department="IT-support / Mjukvara" confidence="0.9" reason="Det gäller mjukvara."]]',
          },
        }),
      }),
    });

    const response = await request(aiApp, 'POST', '/api/ai/suggest', {
      message: 'microsoft word',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.suggestion.department, 'IT-support / Mjukvara');
    assert.equal(warmupSignal.aborted, false);
  } finally {
    abortOllamaWarmup();
    clearInterval(timer);
  }
});

test('POST /api/ai/suggest uses a concise routing prompt with recommendation commands', async () => {
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
              department: 'Grafikgruppen',
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

  assert.match(capturedBody.messages[0].content, /routingassistent/i);
  assert.match(capturedBody.messages[0].content, /så snabbt som möjligt rekommendera/i);
  assert.match(capturedBody.messages[0].content, /huvudmål/i);
  assert.match(capturedBody.messages[0].content, /Tillgängliga avdelningar:/);
  assert.match(capturedBody.messages[0].content, /- Grafikgruppen/);
  assert.match(capturedBody.messages[0].content, /exakt i listan/);
  assert.match(capturedBody.messages[0].content, /alltid skriva minst en kort vanlig mening/);
  assert.match(capturedBody.messages[0].content, /Svara aldrig med enbart kommandoraden/);
  assert.match(capturedBody.messages[0].content, /kommando-rad/i);
  assert.match(capturedBody.messages[0].content, /exempel/i);
  assert.match(capturedBody.messages[0].content, /banner/i);
});

test('POST /api/ai/suggest creates a visible reply if Ollama returns only the command', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: '[[recommend department="IT-support / Mjukvara" confidence="0.9" reason="Användaren beskriver datorproblem."]]',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Har datorproblem',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'IT-support / Mjukvara');
  assert.equal(response.body.reply, 'Det låter som att detta hör till IT-support / Mjukvara.');
  assert.equal(response.body.reply.includes('[[recommend'), false);
});

test('POST /api/ai/suggest includes the currently configured department list in the prompt', async () => {
  let capturedBody = null;
  const state = createDefaultState();
  state.departments = [
    { name: 'Specialteamet', email: 'special@example.com' },
    { name: 'Medlemsfrågor', email: 'medlem@example.com' },
  ];

  const aiApp = createApp({
    state,
    ollamaFetch: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          message: {
            content: 'Det hör till Specialteamet.\n[[recommend department="Specialteamet" confidence="0.9" reason="Det gäller specialteamet."]]',
          },
        }),
      };
    },
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Skicka till specialteamet',
  });

  const systemPrompt = capturedBody.messages[0].content;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'Specialteamet');
  assert.match(systemPrompt, /Tillgängliga avdelningar:/);
  assert.match(systemPrompt, /- Specialteamet/);
  assert.match(systemPrompt, /- Medlemsfrågor/);
  assert.match(systemPrompt, /- Grafikgruppen/);
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

test('POST /api/ai/suggest discourages follow-up questions in the system prompt', async () => {
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
  assert.ok(capturedBody.messages[0].content.includes('Undvik följdfrågor'));
  assert.ok(capturedBody.messages[0].content.includes('högst en kort mening'));
  assert.ok(capturedBody.messages[0].content.includes('Gissa aldrig avdelning'));
  assert.ok(capturedBody.messages[0].content.includes('så fort användarens text innehåller en tydlig signal'));
  assert.ok(capturedBody.messages[0].content.includes('datorproblem'));
  assert.ok(capturedBody.messages[0].content.includes('Microsoft Word'));
  assert.ok(capturedBody.messages[0].content.includes('Skriv kort vad ärendet gäller'));
});

test('POST /api/ai/suggest does not recommend a department for a greeting', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: 'Hej! Vad gäller ditt ärende?',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Hej',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion, null);
  assert.equal(response.body.reply, 'Hej! Vad gäller ditt ärende?');
});

test('POST /api/ai/suggest does not infer a department from plain text alone', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: 'Det här hör till Grafikgruppen, men jag skriver ingen kommando-rad.',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Vi behöver hjälp med en banner.',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion, null);
  assert.equal(response.body.reply, 'Det här hör till Grafikgruppen, men jag skriver ingen kommando-rad.');
});

test('POST /api/ai/suggest extracts a department command from free-form chat', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: 'Det låter som en grafisk beställning.\n[[recommend department="Grafikgruppen" confidence="0.91" reason="Det gäller en banner."]]',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Vi behöver en banner till kampanjen.',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'Grafikgruppen');
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
          content: 'Jag tror att det här är en grafisk sak.\n[[recommend department="Grafikgruppen" confidence="0.85" reason="Det gäller en bild."]',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Jag skulle vilja beställa någon bild',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'Grafikgruppen');
  assert.equal(response.body.reply, 'Jag tror att det här är en grafisk sak.');
});

test('POST /api/ai/suggest maps the legacy graphics department name to Grafikgruppen', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: 'Det låter grafiskt.\n[[recommend department="Grafiska produktionsgruppen" confidence="0.85" reason="Det gäller en bild."]]',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Jag skulle vilja beställa någon bild',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'Grafikgruppen');
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
