const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3001);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_FILE = process.env.BPORTAL_DATA_FILE || path.join(__dirname, 'data', 'orders.json');
const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'granite4.1:3b';
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 30000);
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

const DEPARTMENTS = [
  'Frågor om partiet',
  'Valorganisation',
  'Grafiska produktionsgruppen',
  'IT-support',
];

const USERS = [
  { username: 'user', password: 'user', user: { name: 'Personal', role: 'orderer' } },
  { username: 'user2', password: 'user2', user: { name: 'Grafikgruppen', role: 'graphics' } },
];

const DEMO_ORDERS = [
  { from: 'Erik (Kommunikation)', msg: 'Design av ny flyer för sommarkampanjen.', deadline: '2024-06-15', dept: 'Grafiska produktionsgruppen', status: 'Väntar' },
  { from: 'Anna (HR)', msg: 'Uppdatera profilbilder för ledningsgruppen.', deadline: '2024-06-20', dept: 'Grafiska produktionsgruppen', status: 'Pågående' },
  { from: 'Marknadsavdelningen', msg: 'Ta fram 3 st olika banners för Facebook-annonsering.', deadline: '', dept: 'Grafiska produktionsgruppen', status: 'Ny' },
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
    if (Array.isArray(parsed.orders)) return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not read ${dataFile}: ${error.message}`);
    }
  }

  return createDefaultState();
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

function parseBody(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function validateOrder(payload) {
  const details = [];

  if (!payload || typeof payload !== 'object') {
    return ['body_invalid'];
  }

  if (!String(payload.msg || '').trim()) details.push('msg_required');
  if (!DEPARTMENTS.includes(payload.dept)) details.push('dept_invalid');
  if (String(payload.deadline || '').trim() && !isDateString(payload.deadline)) {
    details.push('deadline_invalid');
  }
  if (payload.attachments !== undefined && !Array.isArray(payload.attachments)) {
    details.push('attachments_invalid');
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

function safeOrder(payload) {
  return {
    id: crypto.randomUUID(),
    createdAt: formatDate(),
    from: String(payload.from || 'Okänd').trim() || 'Okänd',
    msg: String(payload.msg).trim(),
    deadline: String(payload.deadline || '').trim(),
    dept: payload.dept,
    status: 'Ny',
    attachments: safeAttachments(payload),
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

function normalizeDepartmentName(value) {
  const text = String(value || '').trim().toLowerCase();
  return DEPARTMENTS.find((department) => department.toLowerCase() === text) || null;
}

function extractAiSuggestion(content) {
  if (!content) return null;

  const text = String(content).trim();

  try {
    const parsed = JSON.parse(text);
    const department = normalizeDepartmentName(parsed.department);
    return {
      department,
      reason: String(parsed.reason || '').trim(),
      confidence: Number(parsed.confidence || 0),
      reply: String(parsed.reply || '').trim(),
    };
  } catch {
    const commandMatch = text.match(/\[\[\s*recommend\s+department="([^"]+)"(?:\s+confidence="([^"]+)")?(?:\s+reason="([^"]*)")?\s*\]\]?\s*$/i);
    if (commandMatch) {
      const department = normalizeDepartmentName(commandMatch[1]);
      const reply = text.slice(0, commandMatch.index).trim();
      return {
        department,
        reason: String(commandMatch[3] || '').trim() || reply,
        confidence: Number(commandMatch[2] || 0),
        reply,
      };
    }

    const contentText = text.toLowerCase();
    const department = DEPARTMENTS.find((entry) => contentText.includes(entry.toLowerCase()));
    return {
      department: department || null,
      reason: department ? text : '',
      confidence: department ? 0.5 : 0,
      reply: department ? '' : text,
    };
  }
}

function buildAiPrompt() {
  return [
    'Du är en fri chattassistent i en beställningsportal.',
    'Du pratar med användaren som en hjälpsam människa, inte som ett formulär.',
    `Tillåtna avdelningar: ${DEPARTMENTS.join(', ')}.`,
    'Svara fritt och naturligt på svenska. Du får småprata, svara på vardaglig fråga eller vardagliga frågor, ställa följdfrågor och vara konversationsmässig.',
    'Om användaren småpratar får du svara naturligt och kort.',
    'Ditt huvudmål är att hjälpa användaren vidare och, när det passar, rekommendera en avdelning av de tillåtna.',
    'Om du redan kan avgöra rätt avdelning, ställ inga följdfrågor. Säg det kort och vänligt i vanlig text och lägg sedan till exakt en kommando-rad på egen rad i slutet av svaret.',
    'Om användaren frågar varför du föreslog en avdelning, svara kort med motiveringen i vanlig text och rekommendera bara igen om det fortfarande är relevant.',
    'När du vill rekommendera en avdelning, lägg till exakt en kommando-rad på egen rad i slutet av svaret:',
    '[[recommend department="Grafiska produktionsgruppen" confidence="0.93" reason="Kort motivering"]]',
    'Byt ut department till en av de tillåtna avdelningarna och använd confidence mellan 0 och 1.',
    'Om du inte vill rekommendera någon avdelning, skriv bara vanlig text utan kommando.',
    'Exempel:',
    'Användare: Jag behöver hjälp med en banner.',
    'Assistent: Det låter som att detta hör till Grafiska produktionsgruppen.',
    '[[recommend department="Grafiska produktionsgruppen" confidence="0.94" reason="Det gäller en banner."]]',
    'Användare: Hur mår du?',
    'Assistent: Jag mår bra, tack! Hur kan jag hjälpa dig vidare?',
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

async function getAiDepartmentSuggestion(messages, { fetchFn = globalThis.fetch, model = OLLAMA_MODEL } = {}) {
  if (typeof fetchFn !== 'function') {
    return {
      suggestion: null,
      availableDepartments: DEPARTMENTS,
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
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: buildAiPrompt() },
          ...messages,
        ],
        options: {
          temperature: 0.1,
          num_ctx: OLLAMA_NUM_CTX,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`ollama_http_${response.status}`);
    }

    const data = await response.json();
    const suggestion = extractAiSuggestion(data && data.message && data.message.content);
    if (suggestion && suggestion.department) {
      const reply = String(suggestion.reply || '').trim();
      return {
        suggestion: {
          ...suggestion,
          source: 'ollama',
        },
        reply,
        availableDepartments: DEPARTMENTS,
        model,
        source: 'ollama',
      };
    }

    if (suggestion && suggestion.reply) {
      return {
        suggestion: null,
        reply: suggestion.reply,
        availableDepartments: DEPARTMENTS,
        model,
        source: 'ollama',
      };
    }
  } catch (error) {
    return {
      suggestion: null,
      availableDepartments: DEPARTMENTS,
      model,
      source: 'none',
      error: error.message,
    };
  }

  return {
    suggestion: null,
    availableDepartments: DEPARTMENTS,
    model,
    source: 'none',
  };
}

function createApp(options = {}) {
  const state = options.state || loadState(options.dataFile);
  const dataFile = options.dataFile || DATA_FILE;
  const persist = options.persist || Boolean(options.dataFile);

  async function handle({ method, path: requestPath, headers = {}, body = '' }) {
    const url = new URL(requestPath, 'http://localhost');

    if (method === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
        body: '',
      };
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      return json(200, {
        ok: true,
        service: 'bportalen-backend',
        departments: DEPARTMENTS,
      });
    }

    if (method === 'POST' && url.pathname === '/api/login') {
      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const match = USERS.find((entry) => (
        entry.username === payload.username && entry.password === payload.password
      ));

      if (!match) return json(401, { error: 'invalid_credentials' });
      return json(200, { user: match.user });
    }

    if (method === 'GET' && url.pathname === '/api/orders') {
      const dept = url.searchParams.get('dept');
      const from = url.searchParams.get('from');
      const orders = state.orders.filter((order) => (
        (!dept || order.dept === dept)
        && (!from || order.from === from)
      ));

      return json(200, { orders });
    }

    if (method === 'POST' && url.pathname === '/api/orders') {
      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const details = validateOrder(payload);
      if (details.length > 0) {
        return json(400, { error: 'invalid_order', details });
      }

      const order = safeOrder(payload);
      state.orders.unshift(order);
      if (persist) saveState(state, dataFile);

      return json(201, { order });
    }

    if (method === 'POST' && url.pathname === '/api/ai/suggest') {
    const payload = parseBody(body);
    if (!payload) return json(400, { error: 'invalid_json' });

      const messages = normalizeAiMessages(payload);
      if (messages.length === 0) {
        return json(400, { error: 'message_required' });
      }

      const result = await getAiDepartmentSuggestion(messages, {
        fetchFn: options.ollamaFetch || globalThis.fetch?.bind(globalThis),
        model: options.ollamaModel || OLLAMA_MODEL,
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

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
      return text(200, html, 'text/html; charset=utf-8');
    }

    if (method === 'GET' && url.pathname === '/assets/b-logo.svg') {
      const logo = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'b-logo.svg'), 'utf8');
      return text(200, logo, 'image/svg+xml; charset=utf-8');
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
      return handle({
        method: request.method || 'GET',
        path: request.path || '/',
        headers: request.headers || {},
        body: request.body || '',
      });
    },
    listen(port = PORT, callback) {
      const server = http.createServer((req, res) => {
        let body = '';

        req.on('data', (chunk) => {
          body += chunk;
        });

        req.on('end', async () => {
          const response = await handle({
            method: req.method,
            path: req.url,
            headers: req.headers,
            body,
          });

          res.writeHead(response.statusCode, response.headers);
          res.end(response.body);
        });
      });

      return server.listen(port, callback);
    },
  };
}

if (require.main === module) {
  const app = createApp({ persist: true });
  app.listen(PORT, () => {
    console.log(`Bportalen backend kör på http://localhost:${PORT}`);
  });
}

module.exports = {
  createApp,
  createDefaultState,
  DEPARTMENTS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_SIZE,
};
