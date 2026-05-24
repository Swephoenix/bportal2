const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
  'Beställa brochyrer',
  'Grafikgruppen',
  'Medlemsutskick',
  'Medlemsregister',
  'IT-support / Mjukvara',
  'Hemsidan',
  'Marknad',
  'HR / Personalfrågor',
];

const DEPARTMENT_EMAILS = {
  'Frågor om partiet': 'fragor-om-partiet@example.com',
  Valorganisation: 'valorganisation@example.com',
  'Utskick i Sociala medier': 'sociala-medier@example.com',
  Skribentgruppen: 'skribentgruppen@example.com',
  Filmgruppen: 'filmgruppen@example.com',
  Juridikgruppen: 'juridikgruppen@example.com',
  Sekretessavtal: 'sekretessavtal@example.com',
  'Beställa brochyrer': 'brochyrer@example.com',
  Grafikgruppen: 'grafikgruppen@example.com',
  Medlemsutskick: 'medlemsutskick@example.com',
  Medlemsregister: 'medlemsregister@example.com',
  'IT-support / Mjukvara': 'it-support@example.com',
  Hemsidan: 'hemsidan@example.com',
  Marknad: 'marknad@example.com',
  'HR / Personalfrågor': 'hr@example.com',
};

const PROTECTED_DEPARTMENT_NAME = 'Grafikgruppen';

const DEPARTMENT_ALIASES = {
  'grafiska produktionsgruppen': 'Grafikgruppen',
  'grafikproduktion': 'Grafikgruppen',
  'it-support': 'IT-support / Mjukvara',
};

const DEFAULT_DEPARTMENT_RECORDS = DEPARTMENTS.map((name) => ({
  name,
  email: DEPARTMENT_EMAILS[name],
}));

const PROTECTED_DEPARTMENT_RECORD = {
  name: PROTECTED_DEPARTMENT_NAME,
  email: DEPARTMENT_EMAILS[PROTECTED_DEPARTMENT_NAME],
};

const USERS = [
  { username: 'user', password: 'user', user: { name: 'Personal', role: 'orderer' } },
  { username: 'user2', password: 'user2', user: { name: 'Grafikgruppen', role: 'graphics' } },
];

const DEMO_ORDERS = [
  { from: 'Erik (Kommunikation)', msg: 'Design av ny flyer för sommarkampanjen.', deadline: '2024-06-15', dept: 'Grafikgruppen', deptEmail: DEPARTMENT_EMAILS.Grafikgruppen, status: 'Väntar' },
  { from: 'Anna (HR)', msg: 'Uppdatera profilbilder för ledningsgruppen.', deadline: '2024-06-20', dept: 'Grafikgruppen', deptEmail: DEPARTMENT_EMAILS.Grafikgruppen, status: 'Pågående' },
  { from: 'Marknadsavdelningen', msg: 'Ta fram 3 st olika banners för Facebook-annonsering.', deadline: '', dept: 'Grafikgruppen', deptEmail: DEPARTMENT_EMAILS.Grafikgruppen, status: 'Ny' },
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

function normalizeDepartmentRecords(records) {
  if (!Array.isArray(records)) {
    return DEFAULT_DEPARTMENT_RECORDS.map((department) => ({ ...department }));
  }

  const normalized = [];
  const seen = new Set();

  records.forEach((record) => {
    const name = String(record && record.name || '').trim();
    const email = String(record && record.email || '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    normalized.push({
      name,
      email: email || 'placeholder@example.com',
    });
    seen.add(key);
  });

  if (normalized.length === 0) {
    return DEFAULT_DEPARTMENT_RECORDS.map((department) => ({ ...department }));
  }

  if (!seen.has(PROTECTED_DEPARTMENT_NAME.toLowerCase())) {
    normalized.push({ ...PROTECTED_DEPARTMENT_RECORD });
  }

  return normalized;
}

function getDepartmentRecords(state) {
  return normalizeDepartmentRecords(state && state.departments);
}

function getDepartmentNames(state) {
  return getDepartmentRecords(state).map((department) => department.name);
}

function getDepartmentEmails(state) {
  return Object.fromEntries(
    getDepartmentRecords(state).map((department) => [department.name, department.email]),
  );
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

function validateOrder(payload, state) {
  const details = [];

  if (!payload || typeof payload !== 'object') {
    return ['body_invalid'];
  }

  if (!String(payload.msg || '').trim()) details.push('msg_required');
  if (!normalizeDepartmentName(payload.dept, state)) details.push('dept_invalid');
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

function safeOrder(payload, state) {
  const department = normalizeDepartmentName(payload.dept, state);
  const departmentEmails = getDepartmentEmails(state);

  return {
    id: crypto.randomUUID(),
    createdAt: formatDate(),
    from: String(payload.from || 'Okänd').trim() || 'Okänd',
    msg: String(payload.msg).trim(),
    deadline: String(payload.deadline || '').trim(),
    dept: department,
    deptEmail: departmentEmails[department],
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

function normalizeDepartmentName(value, state) {
  const text = String(value || '').trim().toLowerCase();
  const departments = getDepartmentNames(state);
  const alias = DEPARTMENT_ALIASES[text];
  if (alias && departments.includes(alias)) return alias;
  return departments.find((department) => department.toLowerCase() === text) || null;
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

function buildAiPrompt(state) {
  const departments = getDepartmentNames(state);
  const departmentList = departments.map((department) => `- ${department}`).join('\n');

  return [
    'Du är en kortfattad routingassistent i en beställningsportal.',
    'Ditt huvudmål är att så snabbt som möjligt rekommendera rätt avdelning.',
    'Du får alltid den aktuella listan över skapade och tillgängliga avdelningar nedan.',
    'Du får bara rekommendera en avdelning om namnet finns exakt i listan. Hitta aldrig på egna avdelningsnamn.',
    'Tillgängliga avdelningar:',
    departmentList,
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
      const reply = suggestion && suggestion.department
        ? stripRecommendationCommand(rawResponse) || defaultRecommendationReply(suggestion.department)
        : stripRecommendationCommand(rawResponse);

      writeNdjson(write, {
        type: 'final',
        suggestion: suggestion && suggestion.department ? {
          ...suggestion,
          reply,
          source: 'ollama',
        } : null,
        reply,
        rawThinking,
        rawResponse,
        fullResponse,
        availableDepartments: departments,
        model,
        source: 'ollama',
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
function createApp(options = {}) {
  const state = options.state || loadState(options.dataFile);
  const dataFile = options.dataFile || DATA_FILE;
  const persist = options.persist || Boolean(options.dataFile);

  async function handle({ method, path: requestPath, headers = {}, body = '', signal = null }) {
    const url = new URL(requestPath, 'http://localhost');

    if (method === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
        body: '',
      };
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      return json(200, {
        ok: true,
        service: 'bportalen-backend',
        departments: getDepartmentNames(state),
        departmentEmails: getDepartmentEmails(state),
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

    if (method === 'PUT' && url.pathname === '/api/departments') {
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

      const match = USERS.find((entry) => (
        entry.username === payload.username && entry.password === payload.password
      ));

      if (!match) return json(401, { error: 'invalid_credentials' });
      return json(200, { user: match.user });
    }

    if (method === 'GET' && url.pathname === '/api/orders') {
      const dept = url.searchParams.get('dept');
      const normalizedDept = dept ? normalizeDepartmentName(dept, state) : '';
      const from = url.searchParams.get('from');
      if (dept && !normalizedDept) return json(200, { orders: [] });

      const orders = state.orders.filter((order) => (
        (!dept || order.dept === normalizedDept || normalizeDepartmentName(order.dept, state) === normalizedDept)
        && (!from || order.from === from)
      ));

      return json(200, { orders });
    }

    if (method === 'POST' && url.pathname === '/api/orders') {
      const payload = parseBody(body);
      if (!payload) return json(400, { error: 'invalid_json' });

      const details = validateOrder(payload, state);
      if (details.length > 0) {
        return json(400, { error: 'invalid_order', details });
      }

      const order = safeOrder(payload, state);
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
  DEPARTMENT_EMAILS,
  DEFAULT_DEPARTMENT_RECORDS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_SIZE,
};
