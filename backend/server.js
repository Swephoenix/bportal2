const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'bportal.db'));

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
}

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_FILE = process.env.BPORTAL_DATA_FILE || path.join(__dirname, 'data', 'orders.json');
const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'granite4.1:3b';
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 7500);
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT || 120);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '-1';
const OLLAMA_WARMUP = process.env.OLLAMA_WARMUP === '1';
const OLLAMA_WARMUP_INTERVAL_MS = Number(process.env.OLLAMA_WARMUP_INTERVAL_MS || 30 * 60 * 1000);
const OLLAMA_WARMUP_PROMPT = process.env.OLLAMA_WARMUP_PROMPT || 'Svara endast med OK.';
const AMBCENTRAL_API_URL = String(process.env.AMBCENTRAL_API_URL || '').replace(/\/+$/, '');
const ENV_BPORTAL_ADMIN_EMAILS = new Set(
  String(process.env.BPORTAL_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => String(email || '').trim().toLowerCase())
    .filter(Boolean),
);
const PUBLIC_API_BASE_URL = String(process.env.BPORTAL_API_BASE_URL || '').replace(/\/+$/, '');
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

let activeOllamaWarmupAbortController = null;

const DEPARTMENTS = [
  'Frågor om partiet',
  'Valorganisation',
  'Utskick i Sociala medier',
  'Skribentgruppen',
  'Filmgruppen',
  'Juridikgruppen',
  'Sekretessavtal',
  'Beställa broschyrer',
  'Grafikgruppen',
  'Boka zoom-möte',
  'Medlemsutskick',
  'Medlemsregister',
  'IT-support / Mjukvara',
  'Hemsidan',
  'Marknad',
  'HR / Personalfrågor',
];

const DEPARTMENT_DESCRIPTIONS = {
  'Frågor om partiet': 'Allmänna frågor om partiet, politik, organisation och kontaktvägar.',
  Valorganisation: 'Valarbete, kampanjer, flygblad, aktiviteter, valstugor och valrelaterade beställningar.',
  'Utskick i Sociala medier': 'Inlägg, publicering, kampanjer och utskick i sociala medier.',
  Skribentgruppen: 'Texter, korrektur, artiklar, formuleringar, talepunkter och skriftligt innehåll.',
  Filmgruppen: 'Film, video, klippning, inspelning, rörligt material och videoproduktion.',
  Juridikgruppen: 'Juridiska frågor, avtal, regler, rättsliga bedömningar och juridisk rådgivning.',
  Sekretessavtal: 'Sekretessavtal, NDA, hantering av konfidentiell information och relaterade avtal.',
  'Beställa broschyrer': 'Beställningar av broschyrer, trycksaker, foldrar och informationsmaterial.',
  Grafikgruppen: 'Grafik, bilder, design, affischer, banners, layout, logotyper och visuellt material.',
  'Boka zoom-möte': 'Bokning och planering av digitala möten i Zoom.',
  Medlemsutskick: 'Utskick till medlemmar, nyhetsbrev, medlemskommunikation och massutskick.',
  Medlemsregister: 'Medlemsuppgifter, register, adressändringar, medlemsdata och registerfrågor.',
  'IT-support / Mjukvara': 'Datorproblem, inloggning, lösenord, e-post, skrivare, Teams, Office och mjukvara.',
  Hemsidan: 'Webbplatsen, webbsidor, innehåll på hemsidan, publicering och webbändringar.',
  Marknad: 'Marknadsföring, kampanjmaterial, annonsering, varumärke och extern kommunikation.',
  'HR / Personalfrågor': 'Personalfrågor, HR, arbetsmiljö, anställning, ledighet och interna personalärenden.',
};

const PROTECTED_DEPARTMENT_NAMES = new Set(['Grafikgruppen', 'Boka zoom-möte']);

const DEPARTMENT_ALIASES = {
  'grafiska produktionsgruppen': 'Grafikgruppen',
  'grafikproduktion': 'Grafikgruppen',
  'it-support': 'IT-support / Mjukvara',
};

const DEFAULT_DEPARTMENT_RECORDS = DEPARTMENTS.map((name) => ({
  name,
  description: DEPARTMENT_DESCRIPTIONS[name],
}));

const PROTECTED_DEPARTMENT_RECORD = {
  name: 'Grafikgruppen',
  description: DEPARTMENT_DESCRIPTIONS.Grafikgruppen,
};

const SECOND_PROTECTED_DEPARTMENT_RECORD = {
  name: 'Boka zoom-möte',
  description: DEPARTMENT_DESCRIPTIONS['Boka zoom-möte'],
};

const DEFAULT_USERS = [
  { username: 'user', password: 'user', user: { name: 'Anders Jansson', role: 'member', email: 'personal@example.com' } },
  { username: 'lena', password: 'demo', user: { name: 'Lena Karlsson', role: 'member', email: 'lena.karlsson@example.com', group: 'Frågor om partiet', groups: ['Frågor om partiet'] } },
  { username: 'mats', password: 'demo', user: { name: 'Mats Nilsson', role: 'member', email: 'mats.nilsson@example.com', group: 'Valorganisation', groups: ['Valorganisation'] } },
  { username: 'sara', password: 'demo', user: { name: 'Sara Lindberg', role: 'member', email: 'sara.lindberg@example.com', group: 'Utskick i Sociala medier', groups: ['Utskick i Sociala medier'] } },
  { username: 'erik', password: 'demo', user: { name: 'Erik Svensson', role: 'member', email: 'erik.svensson@example.com', group: 'Skribentgruppen', groups: ['Skribentgruppen'] } },
  { username: 'maria', password: 'demo', user: { name: 'Maria Ek', role: 'member', email: 'maria.ek@example.com', group: 'Filmgruppen', groups: ['Filmgruppen'] } },
  { username: 'oskar', password: 'demo', user: { name: 'Oskar Lund', role: 'member', email: 'oskar.lund@example.com', group: 'Juridikgruppen', groups: ['Juridikgruppen'] } },
  { username: 'elin', password: 'demo', user: { name: 'Elin Holm', role: 'member', email: 'elin.holm@example.com', group: 'Sekretessavtal', groups: ['Sekretessavtal'] } },
  { username: 'per', password: 'demo', user: { name: 'Per Gustafsson', role: 'member', email: 'per.gustafsson@example.com', group: 'Beställa broschyrer', groups: ['Beställa broschyrer'] } },
  { username: 'user2', password: 'user2', user: { name: 'Anna Olsson', role: 'member', email: 'grafikgruppen@example.com', group: 'Grafikgruppen', groups: ['Grafikgruppen'] } },
  { username: 'zoom', password: 'demo', user: { name: 'Zoomansvarig', role: 'member', email: 'zoom@example.com', group: 'Boka zoom-möte', groups: ['Boka zoom-möte'] } },
  { username: 'sofia', password: 'demo', user: { name: 'Sofia Bergström', role: 'member', email: 'sofia.bergstrom@example.com', group: 'Medlemsutskick', groups: ['Medlemsutskick'] } },
  { username: 'johan', password: 'demo', user: { name: 'Johan Eriksson', role: 'member', email: 'johan.eriksson@example.com', group: 'Medlemsregister', groups: ['Medlemsregister'] } },
  { username: 'emma', password: 'demo', user: { name: 'Emma Persson', role: 'member', email: 'emma.persson@example.com', group: 'IT-support / Mjukvara', groups: ['IT-support / Mjukvara'] } },
  { username: 'niklas', password: 'demo', user: { name: 'Niklas Åberg', role: 'member', email: 'niklas.aberg@example.com', group: 'Hemsidan', groups: ['Hemsidan'] } },
  { username: 'camilla', password: 'demo', user: { name: 'Camilla Larsson', role: 'member', email: 'camilla.larsson@example.com', group: 'Marknad', groups: ['Marknad'] } },
  { username: 'fredrik', password: 'demo', user: { name: 'Fredrik Sandberg', role: 'member', email: 'fredrik.sandberg@example.com', group: 'HR / Personalfrågor', groups: ['HR / Personalfrågor'] } },
  { username: 'admin', password: 'adminadmin', user: { name: 'Andreas', role: 'admin', email: 'admin@example.com' } },
];

const schemaPath = path.join(__dirname, 'schema.sql');
if (fs.existsSync(schemaPath)) {
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
}

const insertDefaultUser = db.prepare(
  'INSERT OR IGNORE INTO users (username, password_hash, name, role, email) VALUES (?, ?, ?, ?, ?)'
);
const insertDefaultUserGroup = db.prepare(
  'INSERT OR IGNORE INTO user_groups (username, group_name) VALUES (?, ?)'
);
for (const entry of DEFAULT_USERS) {
  const hash = bcrypt.hashSync(entry.password, 10);
  insertDefaultUser.run(entry.username, hash, entry.user.name, entry.user.role, entry.user.email);
  normalizeUserGroups(entry.user).forEach((group) => {
    insertDefaultUserGroup.run(entry.username, group);
  });
}

const DEMO_ORDERS = [
  { from: 'Erik (Kommunikation)', msg: 'Design av ny flyer för sommarkampanjen.', deadline: '2024-06-15', dept: 'Grafikgruppen', status: 'Väntar' },
  { from: 'Anna (HR)', msg: 'Uppdatera profilbilder för ledningsgruppen.', deadline: '2024-06-20', dept: 'Grafikgruppen', status: 'Pågående' },
  { from: 'Marknadsavdelningen', msg: 'Ta fram 3 st olika banners för Facebook-annonsering.', deadline: '', dept: 'Grafikgruppen', status: 'Ny' },
];

function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function createDefaultState() {
  return {
    departments: DEFAULT_DEPARTMENT_RECORDS.map((department) => ({ ...department })),
    users: DEFAULT_USERS.map((entry) => ({
      username: entry.username,
      password: entry.password,
      user: { ...entry.user },
    })),
    userSettings: {},
    orders: DEMO_ORDERS.map((order) => ({
      id: crypto.randomUUID(),
      createdAt: formatDate(),
      ...order,
    })),
  };
}

function loadState(dataFile = DATA_FILE) {
  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.orders)) {
      return {
        departments: normalizeDepartmentRecords(parsed.departments),
        users: normalizeUsers(parsed.users),
        userSettings: normalizeUserSettingsMap(parsed.userSettings),
        orders: parsed.orders,
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not read ${dataFile}: ${error.message}`);
    }
  }

  return createDefaultState();
}

function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'admin') return 'admin';
  return 'member';
}

function normalizeAdminEmailSet(value) {
  if (value instanceof Set) return new Set([...value].map((email) => String(email || '').trim().toLowerCase()).filter(Boolean));
  if (Array.isArray(value)) {
    return new Set(value.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean));
  }
  return new Set(
    String(value || '')
      .split(',')
      .map((email) => String(email || '').trim().toLowerCase())
      .filter(Boolean),
  );
}

function isBportalAdminEmail(email, adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const key = userSettingsKey(email);
  if (!key) return false;
  return adminEmails.has(key);
}

function normalizeAmbCentralRole(role, email = '', adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const r = String(role || '').trim().toLowerCase();
  if (isBportalAdminEmail(email, adminEmails) || r === 'globaladmin') return 'admin';
  return 'member';
}

function normalizeUserGroups(user = {}) {
  const source = user && typeof user === 'object' ? user : {};
  const values = [
    ...(Array.isArray(source.groups) ? source.groups : []),
    source.group,
  ];
  const groups = [];
  const seen = new Set();

  values.forEach((value) => {
    const group = String(value || '').trim();
    const key = group.toLowerCase();
    if (!group || seen.has(key)) return;
    groups.push(group);
    seen.add(key);
  });

  return groups;
}

function normalizeUserEntry(entry) {
  const username = String(entry && entry.username || '').trim();
  const password = String(entry && entry.password || '').trim();
  const rawUser = entry && entry.user && typeof entry.user === 'object' ? entry.user : entry;
  let name = String(rawUser && rawUser.name || username || '').trim();
  const email = userSettingsKey(rawUser && rawUser.email);
  const role = normalizeRole(rawUser && rawUser.role);
  const groups = normalizeUserGroups(rawUser);

  if (username === 'user' && name === 'Personal') name = 'Anders Jansson';
  if (username === 'user2' && name === 'Grafikgruppen') name = 'Anna Olsson';
  if (username === 'admin' && name === 'Admin') name = 'Karin Berg';

  if (!username || !password || !name || !email) return null;

  return {
    username,
    password,
    user: {
      name,
      role,
      email,
      ...(groups.length ? { group: groups[0], groups } : {}),
    },
  };
}

function normalizeUsers(users) {
  const source = Array.isArray(users) ? users : DEFAULT_USERS;
  const normalized = [];
  const seenUsernames = new Set();
  const seenEmails = new Set();

  source.forEach((entry) => {
    const normalizedEntry = normalizeUserEntry(entry);
    if (!normalizedEntry) return;

    const usernameKey = normalizedEntry.username.toLowerCase();
    const emailKey = userSettingsKey(normalizedEntry.user.email);
    if (seenUsernames.has(usernameKey) || seenEmails.has(emailKey)) return;

    normalized.push(normalizedEntry);
    seenUsernames.add(usernameKey);
    seenEmails.add(emailKey);
  });

  return normalized.length ? normalized : DEFAULT_USERS.map((entry) => ({
    username: entry.username,
    password: entry.password,
    user: { ...entry.user },
  }));
}

function publicUserEntry(entry) {
  return {
    username: entry.username,
    name: entry.user.name,
    role: entry.user.role,
    email: entry.user.email,
    group: entry.user.group || '',
    groups: normalizeUserGroups(entry.user),
  };
}

function userGroupsFromDb(username) {
  return db.prepare(
    'SELECT group_name FROM user_groups WHERE username = ? ORDER BY rowid'
  ).all(username).map((row) => row.group_name);
}

function userEntryFromDbRow(row, state = null, adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  if (!row) return null;
  const stateEntry = state
    ? normalizeUsers(state.users).find((entry) => entry.username === row.username)
    : null;
  const dbGroups = userGroupsFromDb(row.username);
  const groups = dbGroups.length
    ? dbGroups
    : normalizeUserGroups(stateEntry && stateEntry.user);

  return {
    username: row.username,
    password: stateEntry ? stateEntry.password : '',
    user: {
      name: row.name,
      role: isBportalAdminEmail(row.email, adminEmails) ? 'admin' : normalizeRole(row.role),
      email: row.email,
      ...(groups.length ? { group: groups[0], groups } : {}),
    },
  };
}

function listUserEntriesFromDb(state = null, adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const rows = db.prepare(
    'SELECT username, name, role, email FROM users ORDER BY username'
  ).all();
  return rows.map((row) => userEntryFromDbRow(row, state, adminEmails)).filter(Boolean);
}

function findUserEntryInDbByUsername(username, state = null, adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const row = db.prepare(
    'SELECT username, name, role, email FROM users WHERE username = ?'
  ).get(username);
  return userEntryFromDbRow(row, state, adminEmails);
}

function findUserEntryInDbByEmail(email, state = null, adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const row = db.prepare(
    'SELECT username, name, role, email FROM users WHERE lower(email) = lower(?)'
  ).get(userSettingsKey(email));
  return userEntryFromDbRow(row, state, adminEmails);
}

function payloadGroups(payload) {
  return [
    ...(Array.isArray(payload && payload.groups) ? payload.groups : []),
    payload && payload.group,
  ].map((group) => String(group || '').trim()).filter(Boolean);
}

function validateUserPayload(payload, state, existingUsername = '', { requirePassword = true } = {}) {
  const details = [];
  const username = String(payload && payload.username || '').trim();
  const password = String(payload && payload.password || '').trim();
  const name = String(payload && payload.name || '').trim();
  const email = userSettingsKey(payload && payload.email);
  const role = String(payload && payload.role || '').trim();
  const groups = payloadGroups(payload);
  const users = normalizeUsers(state.users);
  const existingKey = String(existingUsername || '').toLowerCase();

  if (!username) details.push('username_required');
  if (requirePassword && !password) details.push('password_required');
  if (!name) details.push('name_required');
  if (!email) details.push('email_required');
  if (!['member', 'admin'].includes(role)) details.push('role_invalid');
  if (groups.some((group) => !normalizeDepartmentName(group, state))) details.push('group_invalid');
  if (users.some((entry) => entry.username.toLowerCase() === username.toLowerCase() && entry.username.toLowerCase() !== existingKey)) {
    details.push('username_taken');
  }
  if (users.some((entry) => userSettingsKey(entry.user.email) === email && entry.username.toLowerCase() !== existingKey)) {
    details.push('email_taken');
  }

  return details;
}

function safeUserEntry(payload, state, existingEntry = null) {
  const groups = payloadGroups(payload)
    .map((group) => normalizeDepartmentName(group, state))
    .filter(Boolean)
    .filter((group, index, values) => values.indexOf(group) === index);
  return {
    username: String(payload.username).trim(),
    password: String(payload.password || existingEntry?.password || '').trim(),
    user: {
      name: String(payload.name).trim(),
      role: normalizeRole(payload.role),
      email: userSettingsKey(payload.email),
      ...(groups.length ? { group: groups[0], groups } : {}),
    },
  };
}

function upsertUserInDb(username, password, user = {}) {
  const hash = bcrypt.hashSync(password, 10);
  const groups = normalizeUserGroups(user);
  const saveUser = db.transaction(() => {
    db.prepare(
      'INSERT OR REPLACE INTO users (username, password_hash, name, role, email) VALUES (?, ?, ?, ?, ?)'
    ).run(username, hash, user.name || '', user.role || 'member', user.email || '');
    db.prepare('DELETE FROM user_groups WHERE username = ?').run(username);
    groups.forEach((group) => {
      db.prepare('INSERT INTO user_groups (username, group_name) VALUES (?, ?)').run(username, group);
    });
  });
  saveUser();
  return hash;
}

function deleteUserFromDb(username) {
  db.prepare('DELETE FROM user_groups WHERE username = ?').run(username);
  db.prepare('DELETE FROM users WHERE username = ?').run(username);
}

function defaultUserSettings(user = {}) {
  const isGroupUser = normalizeUserGroups(user).length > 0;
  return {
    notifyOrderResponses: true,
    notifyGroupOrders: isGroupUser,
    notifyGroupReviews: isGroupUser,
  };
}

function userSettingsKey(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUserSettings(settings = {}, user = {}) {
  const defaults = defaultUserSettings(user);
  return {
    notifyOrderResponses: typeof settings.notifyOrderResponses === 'boolean'
      ? settings.notifyOrderResponses
      : defaults.notifyOrderResponses,
    notifyGroupOrders: typeof settings.notifyGroupOrders === 'boolean'
      ? settings.notifyGroupOrders
      : defaults.notifyGroupOrders,
    notifyGroupReviews: typeof settings.notifyGroupReviews === 'boolean'
      ? settings.notifyGroupReviews
      : defaults.notifyGroupReviews,
  };
}

function normalizeUserSettingsMap(settingsMap) {
  if (!settingsMap || typeof settingsMap !== 'object' || Array.isArray(settingsMap)) return {};
  return Object.fromEntries(Object.entries(settingsMap)
    .map(([email, settings]) => [userSettingsKey(email), normalizeUserSettings(settings)])
    .filter(([email]) => email));
}

function getUserSettings(state, user) {
  const key = userSettingsKey(user && user.email);
  return normalizeUserSettings(key ? state.userSettings[key] : {}, user);
}

function setUserSettings(state, user, settings) {
  const key = userSettingsKey(user && user.email);
  if (!key) return null;
  state.userSettings = normalizeUserSettingsMap(state.userSettings);
  state.userSettings[key] = normalizeUserSettings(settings, user);
  return state.userSettings[key];
}

function findUserByEmail(state, email, adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const entry = findUserEntryInDbByEmail(email, state, adminEmails);
  if (entry) return entry.user;
  const key = userSettingsKey(email);
  return normalizeUsers(state.users).map((entry) => entry.user).find((user) => userSettingsKey(user.email) === key) || null;
}

function isAdminRequest(state, headers = {}, adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const email = headers['x-bportal-user-email'] || headers['X-Bportal-User-Email'];
  const user = findUserByEmail(state, email, adminEmails);
  return Boolean(user && user.role === 'admin');
}

function normalizeDepartmentRecords(records) {
  if (!Array.isArray(records)) {
    return DEFAULT_DEPARTMENT_RECORDS.map((department) => ({ ...department }));
  }

  const normalized = [];
  const seen = new Set();

  records.forEach((record) => {
    const name = String(record && record.name || '').trim();
    const description = String(record && record.description || '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    normalized.push({
      name,
      description: description || DEPARTMENT_DESCRIPTIONS[name] || '',
    });
    seen.add(key);
  });

  if (normalized.length === 0) {
    return DEFAULT_DEPARTMENT_RECORDS.map((department) => ({ ...department }));
  }

  for (const protectedDepartmentName of PROTECTED_DEPARTMENT_NAMES) {
    if (seen.has(protectedDepartmentName.toLowerCase())) continue;
    const protectedRecord = protectedDepartmentName === 'Grafikgruppen'
      ? PROTECTED_DEPARTMENT_RECORD
      : SECOND_PROTECTED_DEPARTMENT_RECORD;
    normalized.push({ ...protectedRecord });
    seen.add(protectedDepartmentName.toLowerCase());
  }

  if (normalized.length === 0) {
    return DEFAULT_DEPARTMENT_RECORDS.map((department) => ({ ...department }));
  }

  return normalized;
}

function getDepartmentRecords(state) {
  return normalizeDepartmentRecords(state && state.departments);
}

function getDepartmentNames(state) {
  return getDepartmentRecords(state).map((department) => department.name);
}

function getDepartmentPromptRows(state) {
  return getDepartmentRecords(state).map((department) => {
    const description = String(department.description || '').trim();
    return description
      ? `- ${department.name}: ${description}`
      : `- ${department.name}: Ingen beskrivning angiven. Använd bara namnet om användarens ärende tydligt matchar avdelningen.`;
  });
}

function saveState(state, dataFile = DATA_FILE) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`);
}

function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function text(statusCode, body, contentType) {
  return {
    statusCode,
    headers: {
      'content-type': contentType,
      'access-control-allow-origin': '*',
    },
    body,
  };
}

function stream(statusCode, bodyWriter, headers = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
      connection: 'keep-alive',
      ...headers,
    },
    stream: bodyWriter,
  };
}

function writeNdjson(write, payload) {
  write(`${JSON.stringify(payload)}\n`);
}

function parseBody(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function ambCentralEndpoint(apiUrl, endpointPath) {
  const base = String(apiUrl || '').replace(/\/+$/, '');
  const suffix = String(endpointPath || '').replace(/^\/+/, '');
  return `${base}/${suffix}`;
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function ambCentralRequest(endpointPath, {
  apiUrl = AMBCENTRAL_API_URL,
  fetchFn = globalThis.fetch?.bind(globalThis),
  method = 'GET',
  token = '',
  body = null,
} = {}) {
  if (!apiUrl) {
    return {
      ok: false,
      status: 503,
      data: {
        error: 'ambcentral_not_configured',
        message: 'AMBCENTRAL_API_URL is not configured.',
      },
    };
  }

  if (typeof fetchFn !== 'function') {
    return {
      ok: false,
      status: 503,
      data: {
        error: 'ambcentral_fetch_unavailable',
        message: 'Fetch is not available in this runtime.',
      },
    };
  }

  try {
    const headers = { accept: 'application/json' };
    const options = { method, headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await fetchFn(ambCentralEndpoint(apiUrl, endpointPath), options);
    const data = await responseJson(response);
    return {
      ok: response.ok,
      status: response.status,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      data: {
        error: 'ambcentral_unavailable',
        message: error.message,
      },
    };
  }
}

function usernameFromAmbCentralUser(user = {}) {
  const ref = String(user.ref || '').trim();
  if (ref) return ref;

  const username = String(user.username || '').trim();
  if (username) return username;

  const emailLocalPart = userSettingsKey(user.email).split('@')[0];
  if (emailLocalPart) return emailLocalPart;

  const id = String(user.id || '').trim();
  return id ? `amb-${id}` : '';
}

function nameFromAmbCentralUser(user = {}) {
  return String(
    user.full_name
    || user.name
    || [user.first_name, user.last_name].filter(Boolean).join(' ')
    || userSettingsKey(user.email).split('@')[0]
    || usernameFromAmbCentralUser(user)
  ).trim();
}

function ambCentralStaffEntry(user = {}, existingEntry = null, adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const username = usernameFromAmbCentralUser(user);
  const email = userSettingsKey(user.email);
  const name = nameFromAmbCentralUser(user);
  if (!username || !email || !name) return null;

  const groups = normalizeUserGroups(existingEntry && existingEntry.user);
  return {
    username,
    password: existingEntry?.password || generatePassword(32),
    user: {
      name,
      role: normalizeAmbCentralRole(user.role, email, adminEmails),
      email,
      ...(groups.length ? { group: groups[0], groups } : {}),
    },
  };
}

function syncAmbCentralStaffUsers(state, staffUsers = [], adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const currentUsers = listUserEntriesFromDb(state, adminEmails);
  const currentByEmail = new Map(currentUsers.map((entry) => [userSettingsKey(entry.user.email), entry]));
  const currentByUsername = new Map(currentUsers.map((entry) => [entry.username.toLowerCase(), entry]));
  const synced = [];

  for (const staffUser of Array.isArray(staffUsers) ? staffUsers : []) {
    const email = userSettingsKey(staffUser && staffUser.email);
    const username = usernameFromAmbCentralUser(staffUser);
    const existingEntry = currentByEmail.get(email) || currentByUsername.get(String(username || '').toLowerCase()) || null;
    const entry = ambCentralStaffEntry(staffUser, existingEntry, adminEmails);
    if (!entry) continue;

    if (existingEntry && existingEntry.username !== entry.username) {
      deleteUserFromDb(existingEntry.username);
    }

    upsertUserInDb(entry.username, entry.password, entry.user);
    synced.push(entry);
  }

  const syncedByEmail = new Map(synced.map((entry) => [userSettingsKey(entry.user.email), entry]));
  const merged = [];
  const seen = new Set();
  for (const entry of [...synced, ...currentUsers]) {
    const email = userSettingsKey(entry.user.email);
    if (seen.has(email)) continue;
    merged.push(syncedByEmail.get(email) || entry);
    seen.add(email);
  }

  state.users = merged;
  return synced.map(publicUserEntry);
}

async function handleAmbCentralLogin(payload, state, {
  apiUrl = AMBCENTRAL_API_URL,
  fetchFn = globalThis.fetch?.bind(globalThis),
  persist = false,
  dataFile = DATA_FILE,
  adminEmails = ENV_BPORTAL_ADMIN_EMAILS,
} = {}) {
  const email = userSettingsKey(payload && payload.email);
  const challengeId = String(payload && payload.challenge_id || '').trim();
  const code = String(payload && payload.code || '').trim();

  if (!email) return json(400, { error: 'missing_email' });

  if (!challengeId && !code) {
    const requested = await ambCentralRequest('/api/auth/login', {
      apiUrl,
      fetchFn,
      method: 'POST',
      body: { email },
    });
    return json(requested.status, requested.data);
  }

  if (!challengeId || !code) {
    return json(400, { error: 'missing_code' });
  }

  const verified = await ambCentralRequest('/api/auth/login', {
    apiUrl,
    fetchFn,
    method: 'POST',
    body: { email, challenge_id: challengeId, code },
  });
  if (!verified.ok) return json(verified.status, verified.data);

  const accessToken = String(verified.data.access_token || '');
  if (!accessToken) {
    return json(502, {
      error: 'ambcentral_invalid_response',
      message: 'AmbCentral did not return an access token.',
    });
  }

  const directory = await ambCentralRequest('/api/staff/directory', {
    apiUrl,
    fetchFn,
    token: accessToken,
  });
  if (!directory.ok) return json(directory.status, directory.data);

  const staffUsers = Array.isArray(directory.data.users) ? directory.data.users : [];
  syncAmbCentralStaffUsers(state, staffUsers, adminEmails);
  if (persist) saveState(state, dataFile);

  const currentEntry = findUserEntryInDbByEmail(email, state, adminEmails)
    || ambCentralStaffEntry({ ...verified.data.user, email }, null, adminEmails);
  if (!currentEntry) return json(403, { error: 'access_denied' });

  const publicUser = publicUserEntry(currentEntry);
  return json(200, {
    accessToken,
    expiresIn: Number(verified.data.expires_in || 0),
    user: publicUser,
    settings: getUserSettings(state, currentEntry.user),
  });
}

function bearerTokenFromHeaders(headers = {}) {
  const value = headers.authorization || headers.Authorization || '';
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function resolveRequestUser(state, headers = {}, {
  apiUrl = AMBCENTRAL_API_URL,
  fetchFn = globalThis.fetch?.bind(globalThis),
  adminEmails = ENV_BPORTAL_ADMIN_EMAILS,
} = {}) {
  const token = bearerTokenFromHeaders(headers);
  if (token) {
    const verified = await ambCentralRequest('/api/auth/verify', {
      apiUrl,
      fetchFn,
      token,
    });

    if (verified.ok && verified.data.authenticated !== false) {
      const ambUser = verified.data.user || {};
      const username = usernameFromAmbCentralUser(ambUser);
      const email = userSettingsKey(ambUser.email);
      let entry = username ? findUserEntryInDbByUsername(username, state, adminEmails) : null;
      if (!entry && email) entry = findUserEntryInDbByEmail(email, state, adminEmails);
      if (!entry) {
        entry = ambCentralStaffEntry(ambUser, null, adminEmails);
        if (entry) upsertUserInDb(entry.username, entry.password, entry.user);
      }
      if (entry) return entry.user;
    }
  }

  return findUserByEmail(state, headers['x-bportal-user-email'] || headers['X-Bportal-User-Email'], adminEmails);
}

function validateOrder(payload, state) {
  const details = [];
  const department = normalizeDepartmentName(payload && payload.dept, state);

  if (!payload || typeof payload !== 'object') {
    return ['body_invalid'];
  }

  if (!String(payload.msg || '').trim()) details.push('msg_required');
  if (!department) details.push('dept_invalid');
  if (String(payload.deadline || '').trim() && !isDateString(payload.deadline)) {
    details.push('deadline_invalid');
  }
  if (payload.attachments !== undefined && !Array.isArray(payload.attachments)) {
    details.push('attachments_invalid');
  }
  if (department === 'Boka zoom-möte') {
    const meeting = payload.zoomMeetingRequest;
    if (!meeting || typeof meeting !== 'object') {
      details.push('zoom_meeting_required');
    } else {
      if (!isDateString(meeting.date)) details.push('zoom_meeting_date_invalid');
      if (!/^\d{2}:\d{2}$/.test(String(meeting.time || ''))) details.push('zoom_meeting_time_invalid');
    }
  }
  if (Array.isArray(payload.attachments) && payload.attachments.length > MAX_ATTACHMENTS) {
    details.push('attachments_too_many');
  }

  for (const attachment of Array.isArray(payload.attachments) ? payload.attachments : []) {
    if (!attachment || typeof attachment !== 'object') {
      details.push('attachment_invalid');
      continue;
    }

    if (!String(attachment.name || '').trim()) details.push('attachment_name_required');
    if (!String(attachment.dataUrl || '').startsWith('data:')) details.push('attachment_data_invalid');
    if (Number(attachment.size || 0) > MAX_ATTACHMENT_SIZE) details.push('attachment_too_large');
  }

  return details;
}

function sanitizeAttachmentName(name) {
  const baseName = path.basename(String(name || '').replace(/\\/g, '/')).trim();
  return baseName.replace(/[^\w.\- åäöÅÄÖ]/g, '_') || 'bifogad-fil';
}

function safeAttachments(payload) {
  if (!Array.isArray(payload.attachments)) return [];

  return payload.attachments.map((attachment) => ({
    id: crypto.randomUUID(),
    name: sanitizeAttachmentName(attachment.name),
    type: String(attachment.type || 'application/octet-stream').slice(0, 120),
    size: Number(attachment.size || 0),
    dataUrl: String(attachment.dataUrl),
  }));
}

function safeGraphicsRequest(payload) {
  if (!payload || typeof payload.graphicsRequest !== 'object' || payload.graphicsRequest === null) return null;
  const request = payload.graphicsRequest;
  const channels = Array.isArray(request.channels)
    ? request.channels.map((channel) => String(channel || '').trim().slice(0, 40)).filter(Boolean)
    : [];

  return {
    title: String(request.title || '').trim().slice(0, 160),
    customerName: String(request.customerName || '').trim().slice(0, 120),
    customerEmail: String(request.customerEmail || '').trim().slice(0, 180),
    purpose: String(request.purpose || '').trim().slice(0, 2000),
    contentWishes: String(request.contentWishes || '').trim().slice(0, 2000),
    channels,
    extraMessage: String(request.extraMessage || '').trim().slice(0, 2000),
  };
}

function safeZoomMeetingRequest(payload) {
  if (!payload || typeof payload.zoomMeetingRequest !== 'object' || payload.zoomMeetingRequest === null) return null;
  const request = payload.zoomMeetingRequest;

  return {
    date: String(request.date || '').trim().slice(0, 20),
    time: String(request.time || '').trim().slice(0, 8),
    notes: String(request.notes || '').trim().slice(0, 2000),
  };
}

function findUserEntryByEmail(state, email, adminEmails = ENV_BPORTAL_ADMIN_EMAILS) {
  const entry = findUserEntryInDbByEmail(email, state, adminEmails);
  if (entry) return entry;
  const key = userSettingsKey(email);
  return normalizeUsers(state.users).find((entry) => userSettingsKey(entry.user.email) === key) || null;
}

function safeOrder(payload, state, requestUser = null) {
  const department = normalizeDepartmentName(payload.dept, state);
  const requestUserEntry = requestUser ? findUserEntryByEmail(state, requestUser.email) : null;

  return {
    id: crypto.randomUUID(),
    createdAt: formatDate(),
    from: String(payload.from || 'Okänd').trim() || 'Okänd',
    fromUsername: String(payload.fromUsername || requestUserEntry?.username || '').trim(),
    fromEmail: String(payload.fromEmail || '').trim().slice(0, 180),
    msg: String(payload.msg).trim(),
    deadline: String(payload.deadline || '').trim(),
    dept: department,
    status: 'Ny',
    attachments: safeAttachments(payload),
    graphicsRequest: safeGraphicsRequest(payload),
    zoomMeetingRequest: safeZoomMeetingRequest(payload),
    proposals: [],
  };
}

function findOrder(state, orderId) {
  return state.orders.find((order) => order.id === orderId);
}

function validateProposal(payload) {
  const details = [];
  const attachments = Array.isArray(payload && payload.attachments) ? payload.attachments : [];

  if (!payload || typeof payload !== 'object') return ['body_invalid'];
  if (!String(payload.note || '').trim()) details.push('note_required');
  if (!Array.isArray(payload.attachments) || payload.attachments.length === 0) {
    details.push('proposal_attachments_required');
  }
  if (attachments.length > MAX_ATTACHMENTS) details.push('attachments_too_many');

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      details.push('attachment_invalid');
      continue;
    }

    if (!String(attachment.name || '').trim()) details.push('attachment_name_required');
    if (!isImageAttachment(attachment)) details.push('proposal_attachment_must_be_image');
    if (!String(attachment.dataUrl || '').startsWith('data:')) details.push('attachment_data_invalid');
    if (Number(attachment.size || 0) > MAX_ATTACHMENT_SIZE) details.push('attachment_too_large');
  }

  return details;
}

function isImageAttachment(attachment) {
  return String(attachment.type || '').startsWith('image/')
    || String(attachment.dataUrl || '').startsWith('data:image/');
}

function safeProposal(payload) {
  return {
    id: crypto.randomUUID(),
    createdAt: formatDate(),
    from: String(payload.from || 'Grafikgruppen').trim() || 'Grafikgruppen',
    note: String(payload.note).trim(),
    attachments: safeAttachments(payload),
    review: null,
  };
}

function validateReview(payload, order) {
  const details = [];
  const rating = Number(payload && payload.rating);

  if (!payload || typeof payload !== 'object') return ['body_invalid'];
  if (!String(payload.proposalId || '').trim()) details.push('proposal_id_required');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) details.push('rating_invalid');
  if (!String(payload.response || '').trim()) details.push('response_required');
  if (typeof payload.completed !== 'boolean') details.push('completed_required');
  if (payload.proposalId && !findProposal(order, payload.proposalId)) details.push('proposal_not_found');

  return details;
}

function findProposal(order, proposalId) {
  return Array.isArray(order.proposals)
    ? order.proposals.find((proposal) => proposal.id === proposalId)
    : null;
}

function normalizeDepartmentName(value, state) {
  const text = String(value || '').trim().toLowerCase();
  const departments = getDepartmentNames(state);
  const alias = DEPARTMENT_ALIASES[text];
  if (alias && departments.includes(alias)) return alias;
  return departments.find((department) => department.toLowerCase() === text) || null;
}

function smtpCommand(socket, command) {
  if (command) socket.write(`${command}\r\n`);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      const lines = text.trim().split(/\r?\n/);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        const code = Number(last.slice(0, 3));
        if (code >= 400) reject(new Error(text.trim()));
        else resolve(text);
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function escapeEmailLine(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

async function sendMail({ to, subject, text, html }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const from = process.env.SMTP_FROM || 'bportalen@localhost';
  const username = process.env.SMTP_USER || from;
  const password = process.env.SMTP_PASSWORD || '';
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;

  if (!host || !username || !password) {
    console.log(`[mail not configured] To: ${to} | Subject: ${subject}\n${text || html}`);
    return false;
  }

  let socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.createConnection({ host, port });

  await smtpCommand(socket);
  await smtpCommand(socket, `EHLO ${process.env.SMTP_HELO || 'localhost'}`);
  if (!secure) {
    await smtpCommand(socket, 'STARTTLS');
    socket = tls.connect({ socket, servername: host });
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    await smtpCommand(socket, `EHLO ${process.env.SMTP_HELO || 'localhost'}`);
  }
  await smtpCommand(socket, 'AUTH LOGIN');
  await smtpCommand(socket, Buffer.from(username, 'utf8').toString('base64'));
  await smtpCommand(socket, Buffer.from(password, 'utf8').toString('base64'));
  await smtpCommand(socket, `MAIL FROM:<${from}>`);
  await smtpCommand(socket, `RCPT TO:<${to}>`);
  await smtpCommand(socket, 'DATA');

  const boundary = `bportal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (html) {
    socket.write([
      `From: ${escapeEmailLine(from)}`,
      `To: ${escapeEmailLine(to)}`,
      `Subject: ${escapeEmailLine(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      text || '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      html,
      `--${boundary}--`,
      '.',
      '',
    ].join('\r\n'));
  } else {
    socket.write([
      `From: ${escapeEmailLine(from)}`,
      `To: ${escapeEmailLine(to)}`,
      `Subject: ${escapeEmailLine(subject)}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '.',
      '',
    ].join('\r\n'));
  }

  await smtpCommand(socket);
  await smtpCommand(socket, 'QUIT').catch(() => {});
  socket.end();
  return true;
}

function notifyByEmail(message) {
  const host = process.env.SMTP_HOST;
  const username = process.env.SMTP_USER || process.env.SMTP_FROM || '';
  const password = process.env.SMTP_PASSWORD || '';

  if (!host || !username || !password) {
    return false;
  }

  sendMail(message).catch((error) => {
    console.error('Mail notification failed:', error.message);
  });
  return true;
}

function groupUsersForDepartment(state, department) {
  return normalizeUsers(state.users)
    .map((entry) => entry.user)
    .filter((user) => normalizeUserGroups(user).includes(department));
}

function notifyGroupOrder(state, order) {
  groupUsersForDepartment(state, order.dept).forEach((user) => {
    const settings = getUserSettings(state, user);
    if (!settings.notifyGroupOrders) return;
    notifyByEmail({
      to: user.email,
      subject: `Ny beställning till ${order.dept}`,
      text: [
        `Ny beställning från ${order.from}.`,
        '',
        order.msg,
        '',
        `Deadline: ${order.deadline || 'Ej angiven'}`,
      ].join('\n'),
    });
  });
}

function getOrdererEmail(order) {
  return String(order.fromEmail || order.graphicsRequest?.customerEmail || '').trim();
}

function canAccessOrderChat(state, order, user) {
  if (!order || !user) return false;
  if (user.role === 'admin') return true;

  const orderEmail = userSettingsKey(getOrdererEmail(order));
  const userEmail = userSettingsKey(user.email);
  if (orderEmail && userEmail && orderEmail === userEmail) return true;

  if (normalizeUserGroups(user).includes(order.dept)) return true;

  const ordererName = String(order.from || '').trim().toLowerCase();
  const userName = String(user.name || '').trim().toLowerCase();
  return Boolean(ordererName && userName && ordererName === userName);
}

function notifyOrdererProposal(state, order, proposal) {
  const email = getOrdererEmail(order);
  const user = findUserByEmail(state, email);
  const settings = user ? getUserSettings(state, user) : defaultUserSettings();
  if (!email || !settings.notifyOrderResponses) return;
  notifyByEmail({
    to: email,
    subject: `Svar på din beställning från ${order.dept}`,
    text: [
      `${proposal.from} har svarat på din beställning.`,
      '',
      proposal.note,
    ].join('\n'),
  });
}

function notifyGroupReview(state, order, review) {
  groupUsersForDepartment(state, order.dept).forEach((user) => {
    const settings = getUserSettings(state, user);
    if (!settings.notifyGroupReviews) return;
    notifyByEmail({
      to: user.email,
      subject: `Beställaren har svarat på remiss`,
      text: [
        `${order.from} har svarat på remissen för beställningen till ${order.dept}.`,
        '',
        `Betyg: ${review.rating}`,
        `Status: ${review.completed ? 'Avklarad' : 'Behöver ändras'}`,
        '',
        review.response,
      ].join('\n'),
    });
  });
}

function extractAiSuggestion(content, state) {
  if (!content) return null;

  const text = String(content).trim();

  const commandMatch = text.match(/\[\[\s*recommend\s+department="([^"]+)"(?:\s+confidence="([^"]+)")?(?:\s+reason="([^"]*)")?\s*\]\]?\s*$/i);
  if (commandMatch) {
    const department = normalizeDepartmentName(commandMatch[1], state);
    const reply = text.slice(0, commandMatch.index).trim();
    return {
      department,
      reason: String(commandMatch[3] || '').trim() || reply,
      confidence: Number(commandMatch[2] || 0),
      reply,
    };
  }

  return {
    department: null,
    reason: '',
    confidence: 0,
    reply: text,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferAiSuggestionFromText(messages, reply, state) {
  const replyText = String(reply || '').trim();
  const latestMessage = latestUserMessage(messages);
  const userText = String(latestMessage || '').toLowerCase();
  const availableDepartments = new Set(getDepartmentNames(state));
  const rules = [
    {
      department: 'Grafikgruppen',
      pattern: /\b(grafik|grafisk|bild|bilder|banner|banners|affisch|affischer|design|logo|logotyp|layout|visuell|visuellt)\b/i,
      reason: 'Användaren beskriver grafik, bild, design eller visuellt material.',
    },
    {
      department: 'IT-support / Mjukvara',
      pattern: /\b(datorproblem|dator|inloggning|lösenord|microsoft word|excel|office|e-post|epost|skrivare|teams|zoom|mjukvara|program)\b/i,
      reason: 'Användaren beskriver ett IT- eller mjukvaruärende.',
    },
    {
      department: 'Valorganisation',
      pattern: /\b(valarbete|valstuga|valstugor|kampanj|flygblad|valrelaterad|valrelaterat)\b/i,
      reason: 'Användaren beskriver valarbete eller kampanjmaterial.',
    },
  ];

  const matches = rules
    .filter((rule) => availableDepartments.has(rule.department) && rule.pattern.test(userText));

  if (matches.length === 1) {
    const match = matches[0];
    return {
      department: match.department,
      reason: match.reason,
      confidence: 0.82,
      reply: replyText || defaultRecommendationReply(match.department),
      inferred: true,
    };
  }

  const lowerReply = replyText.toLowerCase();
  const explicitlySkippedCommand = /ingen\s+kommando|utan\s+kommando|skriver\s+ingen/i.test(lowerReply);
  if (!explicitlySkippedCommand) {
    const explicitlyRecommended = getDepartmentNames(state).find((department) => {
      const departmentPattern = escapeRegExp(department).replace(/\\ /g, '\\s+');
      const pattern = new RegExp(`(?:hör\\s+till|låter\\s+som|är\\s+(?:ett|en)|skicka\\s+till|skickas\\s+till)[\\s\\S]{0,40}\\b${departmentPattern}\\b`, 'i');
      return pattern.test(replyText);
    });

    if (explicitlyRecommended) {
      return {
        department: explicitlyRecommended,
        reason: `AI-svaret rekommenderade ${explicitlyRecommended} men saknade kommandoraden.`,
        confidence: 0.78,
        reply: replyText || defaultRecommendationReply(explicitlyRecommended),
        inferred: true,
      };
    }
  }

  return null;
}

function buildAiPrompt(state) {
  const departmentList = getDepartmentPromptRows(state).join('\n');

  return [
    'Du är en kortfattad routingassistent i en beställningsportal.',
    'Ditt huvudmål är att så snabbt som möjligt rekommendera rätt avdelning.',
    'Du får alltid den aktuella listan över skapade och tillgängliga avdelningar nedan.',
    'Du får bara rekommendera en avdelning om namnet finns exakt i listan. Hitta aldrig på egna avdelningsnamn.',
    'Tillgängliga avdelningar och vad de behandlar just nu:',
    departmentList,
    'Använd beskrivningarna ovan som primär källa när du väljer avdelning.',
    'Skriv på svenska, kort och direkt. Använd normalt högst en kort mening före kommandoraden.',
    'När du rekommenderar en avdelning måste du alltid skriva minst en kort vanlig mening före kommandoraden.',
    'Svara aldrig med enbart kommandoraden. Kommandoraden är endast för systemet, inte för användaren.',
    'Undvik följdfrågor. Rekommendera en avdelning så fort användarens text innehåller en tydlig signal, även om texten bara är ett eller två ord.',
    'Ställ bara en följdfråga om det helt saknas ärende, till exempel bara "hej", "ok", "ja", "nej", tack eller rent småprat.',
    'Gissa aldrig avdelning utifrån enbart hälsning, tack, småprat eller allmänna frågor utan ärende.',
    'Tolka korta program- och systemnamn som ärenden när de brukar höra till en avdelning.',
    'Tydliga signaler: datorproblem, inloggning, lösenord, Microsoft Word, Excel, Office, e-post, skrivare, Teams, Zoom eller annan mjukvara => IT-support / Mjukvara; bild, banner, affisch, design eller logo => Grafikgruppen; valarbete, kampanj eller flygblad => Valorganisation.',
    'Om du kan avgöra rätt avdelning från användarens beskrivna ärende, ställ inga följdfrågor. Rekommendera direkt och lägg sedan till exakt en kommando-rad på egen rad i slutet av svaret.',
    'Om användaren frågar varför du föreslog en avdelning, svara kort med motiveringen och rekommendera bara igen om det fortfarande är relevant.',
    'När du vill rekommendera en avdelning, lägg till exakt en kommando-rad på egen rad i slutet av svaret:',
    '[[recommend department="Grafikgruppen" confidence="0.93" reason="Kort motivering"]]',
    'Byt ut department till en av de tillåtna avdelningarna och använd confidence mellan 0 och 1.',
    'Om du inte vill rekommendera någon avdelning, skriv bara vanlig text utan kommando.',
    'En avdelningsknapp visas bara om du faktiskt skriver kommandoraden ovan. Att nämna ett avdelningsnamn i vanlig text räcker inte.',
    'Exempel:',
    'Användare: Jag behöver hjälp med en banner.',
    'Assistent: Det låter som att detta hör till Grafikgruppen.',
    '[[recommend department="Grafikgruppen" confidence="0.94" reason="Det gäller en banner."]]',
    'Användare: Har datorproblem',
    'Assistent: Det låter som ett IT-ärende.',
    '[[recommend department="IT-support / Mjukvara" confidence="0.9" reason="Användaren beskriver datorproblem."]]',
    'Användare: microsoft word',
    'Assistent: Det hör till IT-support / Mjukvara.',
    '[[recommend department="IT-support / Mjukvara" confidence="0.9" reason="Microsoft Word är ett mjukvaruärende."]]',
    'Användare: Hej',
    'Assistent: Hej! Skriv kort vad ärendet gäller.',
    'Användare: Hur mår du?',
    'Assistent: Skriv kort vad ärendet gäller så väljer jag avdelning.',
  ].join('\n');
}

function normalizeAiMessages(payload) {
  const explicitMessages = Array.isArray(payload && payload.messages) ? payload.messages : [];
  const normalized = explicitMessages
    .filter((message) => message && typeof message === 'object')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || '').trim(),
    }))
    .filter((message) => message.content);

  if (normalized.length > 0) {
    return normalized;
  }

  const text = String(payload && (payload.message || payload.text) || '').trim();
  return text ? [{ role: 'user', content: text }] : [];
}

function latestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user' && messages[index].content) {
      return messages[index].content;
    }
  }

  return '';
}

function buildOllamaChatBody(messages, { model = OLLAMA_MODEL, state, stream: streamEnabled = false } = {}) {
  return {
    model,
    stream: streamEnabled,
    keep_alive: ollamaKeepAliveValue(),
    messages: [
      { role: 'system', content: buildAiPrompt(state) },
      ...messages,
    ],
    options: {
      temperature: 0.1,
      num_ctx: OLLAMA_NUM_CTX,
      num_predict: OLLAMA_NUM_PREDICT,
    },
  };
}

function ollamaKeepAliveValue(value = OLLAMA_KEEP_ALIVE) {
  const textValue = String(value).trim();
  return /^-?\d+$/.test(textValue) ? Number(textValue) : textValue;
}

function abortOllamaWarmup() {
  if (!activeOllamaWarmupAbortController) return false;
  activeOllamaWarmupAbortController.abort();
  activeOllamaWarmupAbortController = null;
  return true;
}

async function warmOllamaModel({ fetchFn = globalThis.fetch, model = OLLAMA_MODEL, signal = null } = {}) {
  if (typeof fetchFn !== 'function') return false;

  const response = await fetchFn(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    signal,
    body: JSON.stringify({
      model,
      prompt: OLLAMA_WARMUP_PROMPT,
      stream: false,
      keep_alive: ollamaKeepAliveValue(),
      options: {
        num_ctx: OLLAMA_NUM_CTX,
        num_predict: 1,
      },
    }),
  });

  return Boolean(response && response.ok);
}

function startOllamaWarmupLoop({ fetchFn = globalThis.fetch, model = OLLAMA_MODEL, intervalMs = OLLAMA_WARMUP_INTERVAL_MS } = {}) {
  if (typeof fetchFn !== 'function') return null;

  const runWarmup = async () => {
    if (activeOllamaWarmupAbortController) return;

    const abortController = new AbortController();
    activeOllamaWarmupAbortController = abortController;

    try {
      const ok = await warmOllamaModel({ fetchFn, model, signal: abortController.signal });
      if (!ok) {
        console.warn('Ollama warmup misslyckades.');
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      console.warn(`Ollama warmup misslyckades: ${error.message}`);
    } finally {
      if (activeOllamaWarmupAbortController === abortController) {
        activeOllamaWarmupAbortController = null;
      }
    }
  };

  runWarmup();
  const timer = setInterval(runWarmup, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

function stripRecommendationCommand(text) {
  const rawText = String(text || '');
  const match = rawText.match(/\[\[\s*recommend\b/i);
  return (match ? rawText.slice(0, match.index) : rawText).trimEnd();
}

function defaultRecommendationReply(department) {
  return `Det låter som att detta hör till ${department}.`;
}

function ollamaMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  return [
    String(message.thinking || ''),
    String(message.content || ''),
  ].filter(Boolean).join('');
}

function isOllamaModelLoaded(entry, model) {
  const candidates = [
    entry && entry.name,
    entry && entry.model,
  ].filter(Boolean).map(String);

  return candidates.some((candidate) => candidate === model || candidate.startsWith(`${model}:`));
}

async function getAiModelStatus({ fetchFn = globalThis.fetch, model = OLLAMA_MODEL } = {}) {
  if (typeof fetchFn !== 'function') {
    return {
      status: 'unavailable',
      warm: false,
      model,
      source: 'none',
      error: 'ollama_unavailable',
    };
  }

  try {
    const response = await fetchFn(`${OLLAMA_BASE_URL}/api/ps`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`ollama_http_${response.status}`);
    }

    const data = await response.json();
    const loadedModels = Array.isArray(data && data.models) ? data.models : [];
    const warm = loadedModels.some((entry) => isOllamaModelLoaded(entry, model));

    return {
      status: warm ? 'warm' : 'cold',
      warm,
      model,
      loadedModels: loadedModels.map((entry) => String((entry && (entry.model || entry.name)) || '')).filter(Boolean),
      source: 'ollama',
    };
  } catch (error) {
    return {
      status: 'offline',
      warm: false,
      model,
      source: 'none',
      error: error.message,
    };
  }
}

async function getAiDepartmentSuggestion(messages, { fetchFn = globalThis.fetch, model = OLLAMA_MODEL, state, signal } = {}) {
  const departments = getDepartmentNames(state);

  if (typeof fetchFn !== 'function') {
    return {
      suggestion: null,
      availableDepartments: departments,
      model,
      source: 'none',
      error: 'ollama_unavailable',
    };
  }

  try {
    const response = await fetchFn(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      signal,
      body: JSON.stringify(buildOllamaChatBody(messages, {
        model,
        state,
        stream: false,
      })),
    });

    if (!response.ok) {
      throw new Error(`ollama_http_${response.status}`);
    }

    const data = await response.json();
    const rawResponse = ollamaMessageText(data && data.message);
    const suggestion = extractAiSuggestion(rawResponse, state);
    if (suggestion && suggestion.department) {
      const reply = String(suggestion.reply || '').trim() || defaultRecommendationReply(suggestion.department);
      return {
        suggestion: {
          ...suggestion,
          reply,
          source: 'ollama',
        },
        reply,
        rawResponse,
        availableDepartments: departments,
        model,
        source: 'ollama',
      };
    }

    if (suggestion && suggestion.reply) {
      const inferredSuggestion = inferAiSuggestionFromText(messages, suggestion.reply, state);
      if (inferredSuggestion && inferredSuggestion.department) {
        return {
          suggestion: {
            ...inferredSuggestion,
            source: 'server_fallback',
          },
          reply: inferredSuggestion.reply,
          rawResponse,
          availableDepartments: departments,
          model,
          source: 'server_fallback',
        };
      }

      return {
        suggestion: null,
        reply: suggestion.reply,
        rawResponse,
        availableDepartments: departments,
        model,
        source: 'ollama',
      };
    }
  } catch (error) {
    return {
      suggestion: null,
      availableDepartments: departments,
      model,
      source: 'none',
      error: error.message,
    };
  }

  return {
    suggestion: null,
    availableDepartments: departments,
    model,
    source: 'none',
  };
}

async function getAiDepartmentSuggestionStream(messages, { fetchFn = globalThis.fetch, model = OLLAMA_MODEL, state, signal } = {}) {
  const departments = getDepartmentNames(state);

  if (typeof fetchFn !== 'function') {
    return stream(200, async (write) => {
      writeNdjson(write, {
        type: 'error',
        error: 'ollama_unavailable',
      });
    });
  }

  return stream(200, async (write) => {
    try {
      const response = await fetchFn(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        signal,
        body: JSON.stringify(buildOllamaChatBody(messages, {
          model,
          state,
          stream: true,
        })),
      });

      if (!response.ok) {
        writeNdjson(write, {
          type: 'error',
          error: `ollama_http_${response.status}`,
        });
        return;
      }

      if (!response.body || typeof response.body.getReader !== 'function') {
        writeNdjson(write, {
          type: 'error',
          error: 'ollama_stream_unavailable',
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let rawThinking = '';
      let rawContent = '';

      async function drainBuffer(flush = false) {
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          if (!line) continue;

          const chunk = JSON.parse(line);
          const chunkThinking = String(chunk && chunk.message && chunk.message.thinking || '');
          const chunkContent = String(chunk && chunk.message && chunk.message.content || '');
          if (!chunkThinking && !chunkContent) continue;

          if (chunkThinking) {
            rawThinking += chunkThinking;
            writeNdjson(write, {
              type: 'thinking',
              content: chunkThinking,
            });
          }

          if (chunkContent) {
            rawContent += chunkContent;
            writeNdjson(write, {
              type: 'delta',
              content: chunkContent,
            });
          }
        }

        if (flush) {
          const line = buffer.trim();
          buffer = '';
          if (!line) return;

          const chunk = JSON.parse(line);
          const chunkThinking = String(chunk && chunk.message && chunk.message.thinking || '');
          const chunkContent = String(chunk && chunk.message && chunk.message.content || '');
          if (chunkThinking) {
            rawThinking += chunkThinking;
            writeNdjson(write, {
              type: 'thinking',
              content: chunkThinking,
            });
          }

          if (chunkContent) {
            rawContent += chunkContent;
            writeNdjson(write, {
              type: 'delta',
              content: chunkContent,
            });
          }
        }
      }

      try {
        while (true) {
          if (signal && signal.aborted) {
            return;
          }
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          await drainBuffer(false);
        }

        buffer += decoder.decode();
        await drainBuffer(true);
      } catch (error) {
        if (signal && signal.aborted) {
          return;
        }
        writeNdjson(write, {
          type: 'error',
          error: error.message,
        });
        return;
      }

      const rawResponse = rawContent || rawThinking;
      const fullResponse = rawThinking && rawContent
        ? `${rawThinking}${rawContent}`
        : rawResponse;
      const suggestion = extractAiSuggestion(rawResponse, state);
      const inferredSuggestion = suggestion && suggestion.department
        ? null
        : inferAiSuggestionFromText(messages, suggestion && suggestion.reply ? suggestion.reply : rawResponse, state);
      const finalSuggestion = suggestion && suggestion.department
        ? suggestion
        : inferredSuggestion;
      const reply = finalSuggestion && finalSuggestion.department
        ? stripRecommendationCommand(rawResponse) || defaultRecommendationReply(finalSuggestion.department)
        : stripRecommendationCommand(rawResponse);

      writeNdjson(write, {
        type: 'final',
        suggestion: finalSuggestion && finalSuggestion.department ? {
          ...finalSuggestion,
          reply,
          source: finalSuggestion.inferred ? 'server_fallback' : 'ollama',
        } : null,
        reply,
        rawThinking,
        rawResponse,
        fullResponse,
        availableDepartments: departments,
        model,
        source: finalSuggestion && finalSuggestion.inferred ? 'server_fallback' : 'ollama',
      });
    } catch (error) {
      if (signal && signal.aborted) {
        return;
      }
      writeNdjson(write, {
        type: 'error',
        error: error.message,
      });
    }
  });
}
function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}
function createApp(options = {}) {
  const state = options.state || loadState(options.dataFile);
  const dataFile = options.dataFile || DATA_FILE;
  const persist = options.persist || Boolean(options.dataFile);
  const adminEmails = normalizeAdminEmailSet(options.bportalAdminEmails || ENV_BPORTAL_ADMIN_EMAILS);
  const publicApiBaseUrl = String(options.publicApiBaseUrl || PUBLIC_API_BASE_URL || '').replace(/\/+$/, '');
  const injectedConfig = `window.__BPORTAL_CONFIG__ = ${JSON.stringify({ apiBase: publicApiBaseUrl })};`;

  async function handle({ method, path: requestPath, headers = {}, body = '', signal = null }) {
    const url = new URL(requestPath, 'http://localhost');
    const requestUser = await resolveRequestUser(state, headers, {
      apiUrl: options.ambCentralApiUrl || AMBCENTRAL_API_URL,
      fetchFn: options.ambCentralFetch || globalThis.fetch?.bind(globalThis),
      adminEmails,
    });

    if (method === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type,x-bportal-user-email',
        },
        body: '',
      };
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      return json(200, {
        ok: true,
        service: 'bportalen-backend',
        departments: getDepartmentNames(state),
      });
    }

    if (method === 'GET' && url.pathname === '/api/departments') {
      return json(200, {
        departments: getDepartmentRecords(state),
      });
    }

    if (method === 'GET' && url.pathname === '/api/ai/status') {
      const result = await getAiModelStatus({
        fetchFn: options.ollamaFetch || globalThis.fetch?.bind(globalThis),
        model: options.ollamaModel || OLLAMA_MODEL,
      });

      return json(200, result);
    }

    if (method === 'GET' && url.pathname === '/config.js') {
      return text(200, injectedConfig, 'application/javascript; charset=utf-8');
    }

    if (method === 'PUT' && url.pathname === '/api/departments') {
      if (!requestUser || requestUser.role !== 'admin') return json(403, { error: 'admin_required' });

      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const departments = normalizeDepartmentRecords(payload.departments);
      state.departments = departments;
      if (persist) saveState(state, dataFile);

      return json(200, {
        departments,
      });
    }

    if (method === 'POST' && url.pathname === '/api/login') {
      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      if (payload.email) {
        return handleAmbCentralLogin(payload, state, {
          apiUrl: options.ambCentralApiUrl || AMBCENTRAL_API_URL,
          fetchFn: options.ambCentralFetch || globalThis.fetch?.bind(globalThis),
          persist,
          dataFile,
          adminEmails,
        });
      }

      const userEntry = db.prepare('SELECT * FROM users WHERE username = ?').get(payload.username);

      if (!userEntry || !bcrypt.compareSync(payload.password, userEntry.password_hash)) {
          return json(401, { error: 'invalid_credentials' });
      }
      
      const stateUser = findUserEntryInDbByUsername(userEntry.username, state, adminEmails)
        || normalizeUsers(state.users).find((u) => u.username === userEntry.username);
      const user = {
          username: userEntry.username,
          name: userEntry.name,
          role: userEntry.role,
          email: userEntry.email,
          ...(stateUser ? { group: stateUser.user.group || '', groups: normalizeUserGroups(stateUser.user) } : {}),
      };

      const settings = getUserSettings(state, stateUser && stateUser.user || { email: userEntry.email });
      
      return json(200, { user, settings });
    }

    if (method === 'GET' && url.pathname === '/api/users') {
      return json(200, {
        users: listUserEntriesFromDb(state, adminEmails).map(publicUserEntry),
      });
    }

    if (method === 'POST' && url.pathname === '/api/users') {
      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const details = validateUserPayload(payload, state);
      if (details.length > 0) {
        return json(400, { error: 'invalid_user', details });
      }

      const userEntry = safeUserEntry(payload, state);
      state.users = normalizeUsers(state.users);
      state.users.push(userEntry);
      if (persist) saveState(state, dataFile);

      upsertUserInDb(userEntry.username, userEntry.password, userEntry.user);

      return json(201, { user: publicUserEntry(userEntry) });
    }

    const userActionMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/(send-login|reset-password|impersonate)$/);
    if (method === 'POST' && userActionMatch) {
      if (!requestUser || requestUser.role !== 'admin') return json(403, { error: 'admin_required' });

      const username = decodeURIComponent(userActionMatch[1]);
      const users = listUserEntriesFromDb(state, adminEmails);
      const index = users.findIndex((entry) => entry.username === username);
      if (index === -1) return json(404, { error: 'user_not_found' });

      const action = userActionMatch[2];
      const user = users[index];

      if (action === 'send-login' || action === 'reset-password') {
        return json(410, {
          error: 'ambcentral_managed_login',
          message: 'Inloggning och verifieringskoder hanteras av AmbCentral.',
        });
      }

      if (action === 'impersonate') {
        const adminEmail = requestUser.email;
        console.log(`[AUDIT] User ${adminEmail} started impersonating user ${user.username}`);
        
        // Re-fetch the latest user data from the database-backed user list.
        const currentUsers = listUserEntriesFromDb(state, adminEmails);
        const latestUserEntry = currentUsers.find(u => u.username === user.username);
        const userData = latestUserEntry ? latestUserEntry.user : user;

        const impersonateUser = {
          username: user.username,
          name: userData.name,
          role: userData.role,
          email: userData.email,
          group: userData.group || '',
          groups: normalizeUserGroups(userData),
        };
        const settings = getUserSettings(state, impersonateUser);
        return json(200, { user: impersonateUser, settings });
      }
    }

    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (method === 'PUT' && userMatch) {
      const username = decodeURIComponent(userMatch[1]);
      const users = listUserEntriesFromDb(state, adminEmails);
      const index = users.findIndex((entry) => entry.username === username);
      if (index === -1) return json(404, { error: 'user_not_found' });

      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const details = validateUserPayload(payload, { ...state, users }, username, { requirePassword: false });
      if (details.length > 0) {
        return json(400, { error: 'invalid_user', details });
      }

      users[index] = safeUserEntry(payload, state, users[index]);
      state.users = users;
      if (persist) saveState(state, dataFile);

      upsertUserInDb(users[index].username, users[index].password, users[index].user);

      return json(200, { user: publicUserEntry(users[index]) });
    }

    if (method === 'DELETE' && userMatch) {
      const username = decodeURIComponent(userMatch[1]);
      const users = listUserEntriesFromDb(state, adminEmails);
      const index = users.findIndex((entry) => entry.username === username);
      if (index === -1) return json(404, { error: 'user_not_found' });
      if (users[index].user.role === 'admin' && users.filter((entry) => entry.user.role === 'admin').length === 1) {
        return json(400, { error: 'last_admin' });
      }

      const [removed] = users.splice(index, 1);
      state.users = users;
      state.userSettings = normalizeUserSettingsMap(state.userSettings);
      delete state.userSettings[userSettingsKey(removed.user.email)];
      if (persist) saveState(state, dataFile);

      deleteUserFromDb(removed.username);

      return json(200, { ok: true });
    }

    if (method === 'GET' && url.pathname === '/api/user-settings') {
      const user = findUserByEmail(state, url.searchParams.get('email'));
      if (!user) return json(404, { error: 'user_not_found' });
      return json(200, { settings: getUserSettings(state, user) });
    }

    if (method === 'PUT' && url.pathname === '/api/user-settings') {
      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });
      const user = findUserByEmail(state, payload.email);
      if (!user) return json(404, { error: 'user_not_found' });
      const settings = setUserSettings(state, user, payload.settings);
      if (persist) saveState(state, dataFile);
      return json(200, { settings });
    }

    if (method === 'GET' && url.pathname === '/api/orders') {
      const dept = url.searchParams.get('dept');
      const normalizedDept = dept ? normalizeDepartmentName(dept, state) : '';
      const from = url.searchParams.get('from');
      const fromUsername = url.searchParams.get('fromUsername');
      const fromEmail = url.searchParams.get('fromEmail');
      if (dept && !normalizedDept) return json(200, { orders: [] });

      const orders = state.orders.filter((order) => (
        (!dept || order.dept === normalizedDept || normalizeDepartmentName(order.dept, state) === normalizedDept)
        && (!from || order.from === from)
        && (!fromUsername || String(order.fromUsername || '').trim().toLowerCase() === String(fromUsername || '').trim().toLowerCase())
        && (!fromEmail || String(order.fromEmail || '').trim().toLowerCase() === String(fromEmail || '').trim().toLowerCase())
      ));

      return json(200, { orders });
    }

    if (method === 'POST' && url.pathname.match(/^\/api\/orders\/([^/]+)\/chat$/)) {
      const orderId = url.pathname.match(/^\/api\/orders\/([^/]+)\/chat$/)[1];
      const order = state.orders.find(o => o.id === orderId);
      if (!order) return json(404, { error: 'order_not_found' });
      if (!canAccessOrderChat(state, order, requestUser)) return json(403, { error: 'chat_forbidden' });

      const payload = parseBody(body);
      if (!payload || !payload.message) return json(400, { error: 'invalid_message' });

      if (!order.chat) order.chat = [];
      const message = {
        id: Date.now().toString(),
        from: requestUser.name,
        fromEmail: requestUser.email,
        text: payload.message,
        timestamp: new Date().toISOString()
      };
      order.chat.push(message);
      if (persist) saveState(state, dataFile);

      return json(201, { message });
    }

    if (method === 'GET' && url.pathname.match(/^\/api\/orders\/([^/]+)\/chat$/)) {
      const orderId = url.pathname.match(/^\/api\/orders\/([^/]+)\/chat$/)[1];
      const order = state.orders.find(o => o.id === orderId);
      if (!order) return json(404, { error: 'order_not_found' });
      if (!canAccessOrderChat(state, order, requestUser)) return json(403, { error: 'chat_forbidden' });

      return json(200, { chat: order.chat || [] });
    }
    
    if (method === 'POST' && url.pathname === '/api/orders') {
      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const details = validateOrder(payload, state);
      if (details.length > 0) {
        return json(400, { error: 'invalid_order', details });
      }

      const order = safeOrder(payload, state, requestUser);
      state.orders.unshift(order);
      if (persist) saveState(state, dataFile);
      notifyGroupOrder(state, order);

      return json(201, { order });
    }

    if (method === 'POST' && url.pathname === '/api/ai/suggest') {
      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const messages = normalizeAiMessages(payload);
      if (messages.length === 0) {
        return json(400, { error: 'message_required' });
      }

      if (payload.stream) {
        return getAiDepartmentSuggestionStream(messages, {
          fetchFn: options.ollamaFetch || globalThis.fetch?.bind(globalThis),
          model: options.ollamaModel || OLLAMA_MODEL,
          state,
          signal,
        });
      }

      const result = await getAiDepartmentSuggestion(messages, {
        fetchFn: options.ollamaFetch || globalThis.fetch?.bind(globalThis),
        model: options.ollamaModel || OLLAMA_MODEL,
        state,
        signal,
      });

      return json(200, result);
    }

    const proposalMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/proposals$/);
    if (method === 'POST' && proposalMatch) {
      const order = findOrder(state, proposalMatch[1]);
      if (!order) return json(404, { error: 'order_not_found' });

      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const details = validateProposal(payload);
      if (details.length > 0) {
        return json(400, { error: 'invalid_proposal', details });
      }

      const proposal = safeProposal(payload);
      order.proposals = Array.isArray(order.proposals) ? order.proposals : [];
      order.proposals.unshift(proposal);
      order.status = 'På remiss';
      if (persist) saveState(state, dataFile);
      notifyOrdererProposal(state, order, proposal);

      return json(201, { order, proposal });
    }

    const reviewMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/review$/);
    if (method === 'POST' && reviewMatch) {
      const order = findOrder(state, reviewMatch[1]);
      if (!order) return json(404, { error: 'order_not_found' });

      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const details = validateReview(payload, order);
      if (details.length > 0) {
        return json(400, { error: 'invalid_review', details });
      }

      const proposal = findProposal(order, payload.proposalId);
      proposal.review = {
        rating: Number(payload.rating),
        response: String(payload.response).trim(),
        completed: payload.completed,
        reviewedAt: formatDate(),
      };
      order.status = payload.completed ? 'Avklarad' : 'Behöver ändras';
      if (persist) saveState(state, dataFile);
      notifyGroupReview(state, order, proposal.review);

      return json(200, { order, proposal });
    }

    const reopenMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/reopen$/);
    if (method === 'POST' && reopenMatch) {
      const order = findOrder(state, reopenMatch[1]);
      if (!order) return json(404, { error: 'order_not_found' });
      if (order.status !== 'Avklarad') {
        return json(400, { error: 'order_not_completed' });
      }

      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const reopenedAt = formatDate();
      const historyEntry = {
        reopenedAt,
        note: String(payload.note || '').trim(),
      };

      order.status = 'Återöppnad';
      order.reopenedAt = reopenedAt;
      order.reopenHistory = [historyEntry, ...(Array.isArray(order.reopenHistory) ? order.reopenHistory : [])];
      if (persist) saveState(state, dataFile);

      return json(200, { order });
    }

    if (method === 'GET' && url.pathname === '/admin_overview_orders.html') {
      const html = fs.readFileSync(path.join(__dirname, 'admin_overview_orders.html'), 'utf8');
      return text(200, html, 'text/html; charset=utf-8');
    }

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
      return text(200, html, 'text/html; charset=utf-8');
    }

    if (method === 'GET' && url.pathname === '/assets/b-logo.svg') {
      const logo = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'b-logo.svg'), 'utf8');
      return text(200, logo, 'image/svg+xml; charset=utf-8');
    }

    if (method === 'GET' && url.pathname.startsWith('/assets/')) {
      const assetPath = path.normalize(url.pathname.replace(/^\/assets\//, ''));
      const filePath = path.join(ROOT_DIR, 'assets', assetPath);
      const assetsDir = path.join(ROOT_DIR, 'assets');

      if (!filePath.startsWith(assetsDir + path.sep) && filePath !== path.join(assetsDir, assetPath)) {
        return json(404, { error: 'not_found' });
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        return json(404, { error: 'not_found' });
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = {
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
      }[ext] || 'application/octet-stream';
      const encoding = contentType.startsWith('text/') || contentType.includes('javascript') || contentType.includes('json')
        ? 'utf8'
        : undefined;
      const body = encoding ? fs.readFileSync(filePath, encoding) : fs.readFileSync(filePath);
      return text(200, body, contentType);
    }

    if (method === 'GET' && url.pathname === '/ui-helpers.js') {
      const helpers = fs.readFileSync(path.join(ROOT_DIR, 'ui-helpers.js'), 'utf8');
      return text(200, helpers, 'application/javascript; charset=utf-8');
    }

    return json(404, { error: 'not_found' });
  }

  return {
    handle,
    async inject(request) {
      const response = await handle({
        method: request.method || 'GET',
        path: request.path || '/',
        headers: request.headers || {},
        body: request.body || '',
      });

      if (!response.stream) {
        return response;
      }

      let body = '';
      await response.stream((chunk) => {
        body += chunk;
      });

      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body,
      };
    },
    listen(port = PORT, hostOrCallback = HOST, callback) {
      const host = typeof hostOrCallback === 'function' ? undefined : hostOrCallback;
      const onListening = typeof hostOrCallback === 'function' ? hostOrCallback : callback;
      const server = http.createServer((req, res) => {
        let body = '';
        const requestAbortController = new AbortController();
        const abortRequest = () => {
          if (!requestAbortController.signal.aborted) {
            requestAbortController.abort();
          }
        };

        req.on('data', (chunk) => {
          body += chunk;
        });

        req.on('aborted', abortRequest);

        req.on('end', async () => {
          const response = await handle({
            method: req.method,
            path: req.url,
            headers: req.headers,
            body,
            signal: requestAbortController.signal,
          });

          res.writeHead(response.statusCode, response.headers);
          if (response.stream) {
            const closeHandler = () => abortRequest();
            res.on('close', closeHandler);
            try {
              await response.stream((chunk) => {
                if (!requestAbortController.signal.aborted) {
                  res.write(chunk);
                }
              });
            } finally {
              res.off('close', closeHandler);
            }
            res.end();
            return;
          }

          res.end(response.body);
        });
      });

      server.on('error', (error) => {
        console.error(`Bportalen backend kunde inte starta: ${error.message}`);
        process.exitCode = 1;
      });

      return host
        ? server.listen(port, host, onListening)
        : server.listen(port, onListening);
    },
  };
}

if (require.main === module) {
  const app = createApp({ persist: true });
  app.listen(PORT, HOST, () => {
    console.log(`Bportalen backend kör på http://${HOST}:${PORT}`);
    if (OLLAMA_WARMUP) {
      startOllamaWarmupLoop();
    }
  });
}

module.exports = {
  createApp,
  createDefaultState,
  warmOllamaModel,
  startOllamaWarmupLoop,
  abortOllamaWarmup,
  getAiModelStatus,
  DEPARTMENTS,
  DEFAULT_DEPARTMENT_RECORDS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_SIZE,
};
