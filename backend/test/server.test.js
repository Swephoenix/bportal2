const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createApp,
  createDefaultState,
  DEPARTMENTS,
  warmOllamaModel,
  startOllamaWarmupLoop,
  abortOllamaWarmup,
  seedDemoUsers,
  resetUsersDbForTests,
} = require('../server');

async function request(app, method, path, body, headers = {}) {
  const response = await app.inject({
    method,
    path,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
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

function freshApp(options = {}) {
  if (options.resetDb !== false) resetUsersDbForTests();
  seedDemoUsers();
  return createApp({ state: createDefaultState() });
}

test('GET /api/health reports the backend is ready', async () => {
  const app = freshApp();
  const response = await request(app, 'GET', '/api/health');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, 'bportalen-backend');
  assert.deepEqual(response.body.departments, DEPARTMENTS);
  assert.equal(response.body.departmentEmails, undefined);
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

test('GET /assets/tailwind.css serves the generated stylesheet', async () => {
  const app = freshApp();
  const response = await app.inject({
    method: 'GET',
    path: '/assets/tailwind.css',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/css; charset=utf-8');
  assert.match(response.body, /@tailwind|\.bg-/);
});

test('GET /api/departments lists department names and descriptions', async () => {
  const app = freshApp();
  const response = await request(app, 'GET', '/api/departments');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.departments.some((department) => (
    department.name === 'Grafikgruppen'
    && department.email === undefined
    && department.description.includes('Grafik')
  )), true);
});

test('PUT /api/departments updates departments used by orders', async () => {
  const app = freshApp();
  const updated = await request(app, 'PUT', '/api/departments', {
    departments: [
      {
        name: 'Chefens avdelning',
        description: 'Ledningsfrågor och prioriterade interna beställningar.',
      },
      {
        name: 'Grafikgruppen',
        description: 'Grafiska beställningar.',
      },
    ],
  }, {
    'x-bportal-user-email': 'admin@example.com',
  });

  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.body.departments, [
    {
      name: 'Chefens avdelning',
      description: 'Ledningsfrågor och prioriterade interna beställningar.',
    },
    {
      name: 'Grafikgruppen',
      description: 'Grafiska beställningar.',
    },
    {
      name: 'Boka zoom-möte',
      description: 'Bokning och planering av digitala möten i Zoom.',
    },
    {
      name: 'Lagret',
      description: 'Beställning av profilartiklar, kontorsmaterial, broschyrer och övriga fysiska artiklar från lagret.',
    },
  ]);

  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Skicka till ny avdelning.',
    deadline: '',
    dept: 'Chefens avdelning',
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.order.dept, 'Chefens avdelning');
  assert.equal(created.body.order.deptEmail, undefined);
});

test('PUT /api/departments keeps Grafikgruppen even if it is omitted', async () => {
  const app = freshApp();
  const updated = await request(app, 'PUT', '/api/departments', {
    departments: [
      { name: 'Chefens avdelning' },
    ],
  }, {
    'x-bportal-user-email': 'admin@example.com',
  });

  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.departments.some((department) => (
    department.name === 'Grafikgruppen'
    && department.email === undefined
    && department.description.includes('Grafik')
  )), true);
});

test('PUT /api/departments keeps Boka zoom-möte even if it is omitted', async () => {
  const app = freshApp();
  const updated = await request(app, 'PUT', '/api/departments', {
    departments: [
      { name: 'Chefens avdelning' },
    ],
  }, {
    'x-bportal-user-email': 'admin@example.com',
  });

  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.departments.some((department) => (
    department.name === 'Boka zoom-möte'
    && department.email === undefined
    && department.description.includes('Zoom')
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
  assert.match(response.headers['access-control-allow-headers'], /x-bportal-user-email/);
});

test('PUT /api/departments requires admin user', async () => {
  const app = freshApp();
  const response = await request(app, 'PUT', '/api/departments', {
    departments: [
      { name: 'Chefens avdelning' },
    ],
  }, {
    'x-bportal-user-email': 'personal@example.com',
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, 'admin_required');
});

test('PUT /api/departments accepts an AmbCentral bearer token for an admin', async () => {
  const app = createApp({
    state: createDefaultState(),
    ambCentralApiUrl: 'https://ambcentral.example.test',
    ambCentralFetch: async (url, options = {}) => {
      assert.equal(url, 'https://ambcentral.example.test/api/auth/verify');
      assert.equal(options.headers.Authorization, 'Bearer admin-token');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            authenticated: true,
            user: {
              ref: 'admin',
              full_name: 'Andreas',
              email: 'admin@example.com',
              role: 'globaladmin',
            },
          };
        },
      };
    },
  });

  const response = await request(app, 'PUT', '/api/departments', {
    departments: [
      { name: 'Chefens avdelning' },
    ],
  }, {
    Authorization: 'Bearer admin-token',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.departments[0].name, 'Chefens avdelning');
});

test('GET /config.js exposes the configured public API base', async () => {
  const app = createApp({
    state: createDefaultState(),
    publicApiBaseUrl: 'https://app.example.test',
  });

  const response = await app.inject({
    method: 'GET',
    path: '/config.js',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/javascript; charset=utf-8');
  assert.match(response.body, /window\.__BPORTAL_CONFIG__/);
  assert.match(response.body, /https:\/\/app\.example\.test/);
});

test('POST /api/login accepts a demo member account', async () => {
  const app = freshApp();
  const response = await request(app, 'POST', '/api/login', {
    username: 'user',
    password: 'user',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.name, 'Anders Jansson');
  assert.equal(response.body.user.role, 'member');
  assert.equal(response.body.user.email, 'personal@example.com');
});

test('POST /api/login accepts the admin demo account with password adminadmin', async () => {
  const app = freshApp();
  const response = await request(app, 'POST', '/api/login', {
    username: 'admin',
    password: 'adminadmin',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.name, 'Andreas');
  assert.equal(response.body.user.role, 'admin');
  assert.equal(response.body.user.email, 'admin@example.com');
});

test('POST /api/login requests an AmbCentral email code', async () => {
  const calls = [];
  const app = createApp({
    state: createDefaultState(),
    ambCentralApiUrl: 'https://ambcentral.example.test',
    ambCentralFetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 202,
        async json() {
          return { challenge_id: 'challenge-123', expires_in: 600 };
        },
      };
    },
  });

  const response = await request(app, 'POST', '/api/login', {
    email: 'anna@ambitionsverige.se',
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, { challenge_id: 'challenge-123', expires_in: 600 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ambcentral.example.test/api/auth/login');
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: 'anna@ambitionsverige.se' });
});

test('POST /api/login verifies an AmbCentral code and syncs staff users', async () => {
  const calls = [];
  const app = createApp({
    state: createDefaultState(),
    ambCentralApiUrl: 'https://ambcentral.example.test',
    ambCentralFetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/api/auth/login')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: 'token-abc',
              expires_in: 43200,
              user: {
                id: 7,
                ref: 'U10007',
                full_name: 'Anna Andersson',
                email: 'anna@ambitionsverige.se',
                role: 'administrator',
              },
            };
          },
        };
      }

      assert.equal(url, 'https://ambcentral.example.test/api/staff/directory');
      assert.equal(options.headers.Authorization, 'Bearer token-abc');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            users: [
              {
                id: 7,
                ref: 'U10007',
                full_name: 'Anna Andersson',
                email: 'anna@ambitionsverige.se',
                role: 'administrator',
              },
              {
                id: 8,
                ref: 'U10008',
                full_name: 'Val Arbetare',
                email: 'val@ambitionsverige.se',
                role: 'valarbetare',
              },
            ],
            total: 2,
          };
        },
      };
    },
  });

  const response = await request(app, 'POST', '/api/login', {
    email: 'anna@ambitionsverige.se',
    challenge_id: 'challenge-123',
    code: '482916',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.accessToken, 'token-abc');
  assert.equal(response.body.expiresIn, 43200);
  assert.deepEqual(response.body.user, {
    username: 'U10007',
    name: 'Anna Andersson',
    role: 'member',
    email: 'anna@ambitionsverige.se',
    group: '',
    groups: [],
  });

  const users = await request(app, 'GET', '/api/users');
  assert.equal(users.statusCode, 200);
  assert.equal(users.body.users.some((user) => (
    user.username === 'U10008'
    && user.name === 'Val Arbetare'
    && user.email === 'val@ambitionsverige.se'
    && user.role === 'member'
  )), true);
  assert.equal(calls.length, 2);
});

test('POST /api/login marks only the configured Bportal admin emails as admin', async () => {
  const app = createApp({
    state: createDefaultState(),
    bportalAdminEmails: new Set([
      'andreas.jansson@ambitionsverige.se',
      'mattias.kihl@ambitionsverige.se',
    ]),
    ambCentralApiUrl: 'https://ambcentral.example.test',
    ambCentralFetch: async (url, options = {}) => {
      if (url.endsWith('/api/auth/login')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: 'token-admins',
              expires_in: 43200,
              user: {
                ref: 'U20001',
                full_name: 'Andreas Jansson',
                email: 'andreas.jansson@ambitionsverige.se',
                role: 'administrator',
              },
            };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            users: [
              {
                ref: 'U20001',
                full_name: 'Andreas Jansson',
                email: 'andreas.jansson@ambitionsverige.se',
                role: 'administrator',
              },
              {
                ref: 'U20002',
                full_name: 'Mattias Kihl',
                email: 'mattias.kihl@ambitionsverige.se',
                role: 'valarbetare',
              },
              {
                ref: 'U20003',
                full_name: 'Val Arbetare',
                email: 'val@ambitionsverige.se',
                role: 'administrator',
              },
            ],
            total: 3,
          };
        },
      };
    },
  });

  const response = await request(app, 'POST', '/api/login', {
    email: 'andreas.jansson@ambitionsverige.se',
    challenge_id: 'challenge-123',
    code: '482916',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.role, 'admin');

  const users = await request(app, 'GET', '/api/users');
  const byEmail = Object.fromEntries(users.body.users.map((user) => [user.email, user.role]));
  assert.equal(byEmail['andreas.jansson@ambitionsverige.se'], 'admin');
  assert.equal(byEmail['mattias.kihl@ambitionsverige.se'], 'admin');
  assert.equal(byEmail['val@ambitionsverige.se'], 'member');
});

test('POST /api/login forwards AmbCentral login errors', async () => {
  const app = createApp({
    state: createDefaultState(),
    ambCentralApiUrl: 'https://ambcentral.example.test',
    ambCentralFetch: async () => ({
      ok: false,
      status: 403,
      async json() {
        return { error: 'access_denied', message: 'User has no staff role' };
      },
    }),
  });

  const response = await request(app, 'POST', '/api/login', {
    email: 'anna@ambitionsverige.se',
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, {
    error: 'access_denied',
    message: 'User has no staff role',
  });
});

test('default demo users are not pre-assigned to any department', async () => {
  const app = freshApp();
  const response = await request(app, 'GET', '/api/users');

  assert.equal(response.statusCode, 200);
  // Only check the built-in DEFAULT_USERS (not users created by other tests)
  const defaultUsernames = new Set(['user', 'lena', 'mats', 'sara', 'erik', 'maria', 'oskar', 'elin', 'per', 'user2', 'zoom', 'sofia', 'johan', 'emma', 'niklas', 'camilla', 'fredrik', 'admin']);
  for (const user of response.body.users) {
    if (!defaultUsernames.has(user.username)) continue;
    if (user.username === 'admin') continue;
    assert.equal(
      Array.isArray(user.groups) && user.groups.length > 0,
      false,
      `${user.username} should not have pre-assigned groups`,
    );
  }
});

test('admin user API creates and assigns department users', async () => {
  const app = freshApp();
  const created = await request(app, 'POST', '/api/users', {
    username: 'it',
    password: 'secret',
    name: 'IT-support',
    role: 'member',
    email: 'it@example.com',
    group: 'IT-support / Mjukvara',
  });

  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.user, {
    username: 'it',
    name: 'IT-support',
    role: 'member',
    email: 'it@example.com',
    group: 'IT-support / Mjukvara',
    groups: ['IT-support / Mjukvara'],
  });

  const login = await request(app, 'POST', '/api/login', {
    username: 'it',
    password: 'secret',
  });

  assert.equal(login.statusCode, 200);
  assert.equal(login.body.user.group, 'IT-support / Mjukvara');
  assert.deepEqual(login.body.user.groups, ['IT-support / Mjukvara']);
  assert.equal(login.body.settings.notifyGroupOrders, true);
  assert.equal(login.body.settings.notifyGroupReviews, true);
});

test('admin user API creates users assigned to multiple departments', async () => {
  const app = freshApp();
  const created = await request(app, 'POST', '/api/users', {
    username: 'multi',
    password: 'secret',
    name: 'Multiavdelning',
    role: 'member',
    email: 'multi@example.com',
    groups: ['IT-support / Mjukvara', 'Hemsidan'],
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.user.group, 'IT-support / Mjukvara');
  assert.deepEqual(created.body.user.groups, ['IT-support / Mjukvara', 'Hemsidan']);

  const login = await request(app, 'POST', '/api/login', {
    username: 'multi',
    password: 'secret',
  });

  assert.equal(login.statusCode, 200);
  assert.deepEqual(login.body.user.groups, ['IT-support / Mjukvara', 'Hemsidan']);
  assert.equal(login.body.settings.notifyGroupOrders, true);
});

test('GET /api/users lists users persisted in sqlite even when they are not in state', async () => {
  const app = freshApp();
  const username = `dbonly_${process.pid}_${Date.now()}`;
  const email = `${username}@example.com`;

  try {
    await request(app, 'POST', '/api/users', {
      username,
      password: 'secret',
      name: 'Databasanvändare',
      role: 'member',
      email,
      groups: ['Hemsidan'],
    });

    const reloadedApp = freshApp({ resetDb: false });
    const response = await request(reloadedApp, 'GET', '/api/users');

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.body.users.some((user) => (
        user.username === username
        && user.name === 'Databasanvändare'
        && user.email === email
        && Array.isArray(user.groups)
        && user.groups.includes('Hemsidan')
      )),
      true,
    );
  } finally {
    await request(freshApp(), 'DELETE', `/api/users/${encodeURIComponent(username)}`);
  }
});

test('admin user API edits users without requiring a password change', async () => {
  const app = freshApp();
  await request(app, 'POST', '/api/users', {
    username: 'it',
    password: 'secret',
    name: 'IT-support',
    role: 'member',
    email: 'it@example.com',
    group: 'IT-support / Mjukvara',
  });

  const updated = await request(app, 'PUT', '/api/users/it', {
    username: 'it',
    password: '',
    name: 'IT-gruppen',
    role: 'member',
    email: 'it@example.com',
    group: 'Hemsidan',
  });

  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.user.name, 'IT-gruppen');
  assert.equal(updated.body.user.group, 'Hemsidan');
  assert.deepEqual(updated.body.user.groups, ['Hemsidan']);

  const login = await request(app, 'POST', '/api/login', {
    username: 'it',
    password: 'secret',
  });

  assert.equal(login.statusCode, 200);
  assert.equal(login.body.user.name, 'IT-gruppen');
});

test('admin user API prevents removing the final admin', async () => {
  const app = freshApp();
  const response = await request(app, 'DELETE', '/api/users/admin');

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'last_admin');
});

test('admin user API no longer sends or resets local passwords', async () => {
  const app = freshApp();
  const response = await request(app, 'POST', '/api/users/user/send-login', undefined, {
    'x-bportal-user-email': 'admin@example.com',
  });

  assert.equal(response.statusCode, 410);
  assert.equal(response.body.error, 'ambcentral_managed_login');
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
  assert.equal(created.body.order.deptEmail, undefined);
  assert.ok(created.body.order.id);

  const listed = await request(app, 'GET', '/api/orders?dept=Grafikgruppen');

  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.orders[0].id, created.body.order.id);
  assert.equal(listed.body.orders[0].msg, 'Skapa en banner till kampanjen.');
});

test('POST /api/orders stores the sender username when the request is authenticated', async () => {
  const app = freshApp();
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Anders Jansson',
    fromEmail: 'personal@example.com',
    msg: 'Skapa en banner till kampanjen.',
    deadline: '2026-06-01',
    dept: 'Grafikgruppen',
  }, {
    'x-bportal-user-email': 'personal@example.com',
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.order.fromUsername, 'user');

  const listed = await request(app, 'GET', '/api/orders?fromUsername=user');

  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.orders[0].id, created.body.order.id);
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

test('POST /api/orders stores structured graphics order fields', async () => {
  const app = freshApp();
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: [
      'Rubrik: Kampanjbanner',
      'Beställare: Personal',
      'E-post: personal@example.com',
      'Kanaler: Facebook, Instagram',
    ].join('\n'),
    deadline: '2026-06-01',
    dept: 'Grafikgruppen',
    graphicsRequest: {
      title: 'Kampanjbanner',
      customerName: 'Personal',
      customerEmail: 'personal@example.com',
      purpose: 'Skapa intresse för kampanjen.',
      contentWishes: 'Tydlig avsändare och kort budskap.',
      channels: ['Facebook', 'Instagram'],
      extraMessage: 'Behöver vara klar före lunch.',
    },
  });

  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.order.graphicsRequest, {
    title: 'Kampanjbanner',
    customerName: 'Personal',
    customerEmail: 'personal@example.com',
    purpose: 'Skapa intresse för kampanjen.',
    contentWishes: 'Tydlig avsändare och kort budskap.',
    channels: ['Facebook', 'Instagram'],
    extraMessage: 'Behöver vara klar före lunch.',
  });
});

test('POST /api/orders stores structured zoom meeting fields', async () => {
  const app = freshApp();
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Jag vill boka ett zoom-möte.',
    deadline: '2026-06-02',
    dept: 'Boka zoom-möte',
    zoomMeetingRequest: {
      date: '2026-06-02',
      time: '10:00',
      notes: 'Behöver en länk till mötet.',
    },
  });

  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.order.zoomMeetingRequest, {
    date: '2026-06-02',
    time: '10:00',
    notes: 'Behöver en länk till mötet.',
  });
});

test('POST and GET /api/orders/:id/chat are limited to the order owner and department members', async () => {
  const app = freshApp();
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Anders Jansson',
    fromEmail: 'personal@example.com',
    msg: 'Skapa en banner till kampanjen.',
    deadline: '2026-06-01',
    dept: 'Grafikgruppen',
  });

  const ownerRead = await request(app, 'GET', `/api/orders/${created.body.order.id}/chat`, undefined, {
    'x-bportal-user-email': 'personal@example.com',
  });
  assert.equal(ownerRead.statusCode, 200);
  assert.deepEqual(ownerRead.body.chat, []);

  const ownerWrite = await request(app, 'POST', `/api/orders/${created.body.order.id}/chat`, {
    message: 'Hej, jag vill gärna följa upp beställningen.',
  }, {
    'x-bportal-user-email': 'personal@example.com',
  });
  assert.equal(ownerWrite.statusCode, 201);
  assert.equal(ownerWrite.body.message.text, 'Hej, jag vill gärna följa upp beställningen.');

  // Skapa en användare kopplad till Grafikgruppen för att testa gruppåtkomst
  const createdUser = await request(app, 'POST', '/api/users', {
    username: 'grafiker',
    password: 'secret',
    name: 'Grafiker',
    role: 'member',
    email: 'grafiker@example.com',
    groups: ['Grafikgruppen'],
  });
  assert.equal(createdUser.statusCode, 201, `user creation failed: ${JSON.stringify(createdUser.body)}`);

  const memberRead = await request(app, 'GET', `/api/orders/${created.body.order.id}/chat`, undefined, {
    'x-bportal-user-email': 'grafiker@example.com',
  });
  assert.equal(memberRead.statusCode, 200);
  assert.equal(memberRead.body.chat.length, 1);

  const memberWrite = await request(app, 'POST', `/api/orders/${created.body.order.id}/chat`, {
    message: 'Vi har tagit hand om den.',
  }, {
    'x-bportal-user-email': 'grafiker@example.com',
  });
  assert.equal(memberWrite.statusCode, 201);
  assert.equal(memberWrite.body.message.text, 'Vi har tagit hand om den.');

  const forbiddenRead = await request(app, 'GET', `/api/orders/${created.body.order.id}/chat`, undefined, {
    'x-bportal-user-email': 'lena.karlsson@example.com',
  });
  assert.equal(forbiddenRead.statusCode, 403);
  assert.equal(forbiddenRead.body.error, 'chat_forbidden');

  const forbiddenWrite = await request(app, 'POST', `/api/orders/${created.body.order.id}/chat`, {
    message: 'Jag borde inte komma åt detta.',
  }, {
    'x-bportal-user-email': 'lena.karlsson@example.com',
  });
  assert.equal(forbiddenWrite.statusCode, 403);
  assert.equal(forbiddenWrite.body.error, 'chat_forbidden');
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

test('GET /api/orders can filter orders by sender username', async () => {
  const app = freshApp();
  const personal = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    fromUsername: 'personal-user',
    msg: 'Min skickade beställning.',
    deadline: '',
    dept: 'IT-support / Mjukvara',
  });

  const listed = await request(app, 'GET', '/api/orders?fromUsername=personal-user');

  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.body.orders.map((order) => order.id), [personal.body.order.id]);
});

test('GET /api/orders only returns orders for the matching sender username', async () => {
  const app = freshApp();
  const personal = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    fromUsername: 'personal-user',
    msg: 'Min skickade beställning.',
    deadline: '',
    dept: 'IT-support / Mjukvara',
  });
  await request(app, 'POST', '/api/orders', {
    from: 'Annan användare',
    fromUsername: 'someone-else',
    msg: 'Ska inte synas för Personal.',
    deadline: '',
    dept: 'IT-support / Mjukvara',
  });

  const listed = await request(app, 'GET', '/api/orders?fromUsername=personal-user');

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

test('POST /api/ai/suggest stream infers a clear graphics suggestion if command is missing', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('{"message":{"content":"Det låter som en Grafikgruppen-ärende."}}\n'),
    encoder.encode('{"done":true}\n'),
  ];
  let chunkIndex = 0;

  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
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
    }),
  });

  const response = await aiApp.inject({
    method: 'POST',
    path: '/api/ai/suggest',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: 'Jag behöver en bild till en kampanj.',
      stream: true,
    }),
  });

  assert.equal(response.statusCode, 200);
  const lines = response.body.trim().split('\n').map((line) => JSON.parse(line));
  const final = lines.at(-1);
  assert.equal(final.type, 'final');
  assert.equal(final.suggestion.department, 'Grafikgruppen');
  assert.equal(final.suggestion.source, 'server_fallback');
  assert.equal(final.reply, 'Det låter som en Grafikgruppen-ärende.');
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
  assert.match(capturedBody.messages[0].content, /Tillgängliga avdelningar och vad de behandlar just nu:/);
  assert.match(capturedBody.messages[0].content, /- Grafikgruppen: Grafik, bilder, design/);
  assert.match(capturedBody.messages[0].content, /Använd beskrivningarna ovan som primär källa/);
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
    {
      name: 'Specialteamet',
      description: 'Specialärenden, svåra interna frågor och extra prioriterade beställningar.',
    },
    {
      name: 'Medlemsfrågor',
      description: 'Frågor från medlemmar, medlemsservice och stöd till medlemmar.',
    },
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
  assert.match(systemPrompt, /Tillgängliga avdelningar och vad de behandlar just nu:/);
  assert.match(systemPrompt, /- Specialteamet: Specialärenden, svåra interna frågor och extra prioriterade beställningar\./);
  assert.match(systemPrompt, /- Medlemsfrågor: Frågor från medlemmar, medlemsservice och stöd till medlemmar\./);
  assert.match(systemPrompt, /- Grafikgruppen: Grafik, bilder, design, affischer, banners, layout, logotyper och visuellt material\./);
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

test('POST /api/ai/suggest infers a clear graphics suggestion if Ollama omits the command', async () => {
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
  assert.equal(response.body.suggestion.department, 'Grafikgruppen');
  assert.equal(response.body.suggestion.source, 'server_fallback');
  assert.equal(response.body.suggestion.inferred, true);
  assert.equal(response.body.reply, 'Det här hör till Grafikgruppen, men jag skriver ingen kommando-rad.');
});

test('POST /api/ai/suggest infers an explicit department recommendation from plain AI text', async () => {
  const aiApp = createApp({
    state: createDefaultState(),
    ollamaFetch: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: 'Det låter som en Grafikgruppen-ärende.',
        },
      }),
    }),
  });

  const response = await request(aiApp, 'POST', '/api/ai/suggest', {
    message: 'Jag behöver en bild till en kampanj.',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.suggestion.department, 'Grafikgruppen');
  assert.equal(response.body.suggestion.source, 'server_fallback');
  assert.equal(response.body.reply, 'Det låter som en Grafikgruppen-ärende.');
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

test('DEPARTMENTS includes Lagret', () => {
  assert.equal(DEPARTMENTS.includes('Lagret'), true);
});

test('PUT /api/departments keeps Lagret even if it is omitted', async () => {
  const app = freshApp();
  const updated = await request(app, 'PUT', '/api/departments', {
    departments: [
      { name: 'Chefens avdelning' },
    ],
  }, {
    'x-bportal-user-email': 'admin@example.com',
  });

  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.departments.some((department) => (
    department.name === 'Lagret'
    && department.email === undefined
    && department.description.includes('artiklar')
  )), true);
});

test('POST /api/orders stores structured article request fields for Lagret', async () => {
  const app = freshApp();
  const created = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Beställning från lagret.',
    deadline: '2026-06-10',
    dept: 'Lagret',
    articleRequest: {
      articleName: 'Profilpennor',
      quantity: '50',
      unit: 'st',
      notes: 'Blå färg med partilogga.',
    },
  });

  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.order.articleRequest, {
    articleName: 'Profilpennor',
    quantity: '50',
    unit: 'st',
    notes: 'Blå färg med partilogga.',
  });
});

test('POST /api/orders rejects Lagret order without article name', async () => {
  const app = freshApp();
  const response = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Beställning från lagret.',
    deadline: '2026-06-10',
    dept: 'Lagret',
    articleRequest: {
      quantity: '10',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'invalid_order');
  assert.deepEqual(response.body.details, ['article_name_required']);
});

test('POST /api/orders rejects Lagret order without quantity', async () => {
  const app = freshApp();
  const response = await request(app, 'POST', '/api/orders', {
    from: 'Personal',
    msg: 'Beställning från lagret.',
    deadline: '2026-06-10',
    dept: 'Lagret',
    articleRequest: {
      articleName: 'Profilpennor',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'invalid_order');
  assert.deepEqual(response.body.details, ['article_quantity_required']);
});
