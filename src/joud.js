// ============================================================
//  src/joud.js
//  joud.chat WhatsApp API client + template parsing.
// ============================================================
import { config } from './config.js';

const TIMEOUT_MS = 10000;

// Small helper: fetch with a hard timeout so a hanging joud.chat call
// can never block a Shopify webhook beyond ~10s.
async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Defensive JSON.parse: joud.chat returns several JSON-encoded strings
// (template_json, variable_map, button_content). Never throw.
export function safeJsonParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

// Extract {{1}} / {{name}} style placeholders from a text blob.
function extractPlaceholders(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

// ------------------------------------------------------------
//  parseTemplate(rawTemplateObj)
//  Normalizes one joud.chat template object into:
//  { templateId, name, type, locale, body, header, footer,
//    variables: [{ name, index, section }], quickReplyButtons: [...] }
//
//  Variable detection strategy (defensive, multiple sources):
//   1. variable_map.header[] and variable_map.body[] (preferred).
//   2. Placeholders scanned from header_content + body_content.
//  Index is 1-based and assigned in the order header-then-body so the
//  `templateVariable-<name>-<index>` keys match joud.chat's expectation.
// ------------------------------------------------------------
export function parseTemplate(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const templateId = String(raw.template_id || raw.id || '');
  // joud.chat's INTERNAL id (e.g. 374827). The send/template endpoint
  // expects THIS as `template_id`, NOT the long Meta/WhatsApp id
  // (e.g. 2094622431108343) which we keep above for identity/matching.
  const joudId = String(raw.id || raw.template_id || '');
  const name = raw.template_name || raw.name || `template-${templateId}`;
  const body = raw.body_content || '';
  const header = raw.header_content || '';
  const footer = raw.footer_content || '';

  const variableMap = safeJsonParse(raw.variable_map, {}) || {};
  const buttonContent = safeJsonParse(raw.button_content, null);
  const templateJson = safeJsonParse(raw.template_json, {}) || {};

  // Strip the various placeholder wrappers joud.chat / Meta use:
  //   {{1}}         -> 1
  //   #!storeName!# -> storeName
  //   #store_name#  -> store_name
  const cleanVarName = (t) => {
    if (t == null) return '';
    let s = typeof t === 'object'
      ? String(t.name ?? t.value ?? t.key ?? '').trim()
      : String(t).trim();
    s = s.replace(/^\{\{\s*|\s*\}\}$/g, ''); // {{ x }}
    s = s.replace(/^#!\s*|\s*!#$/g, ''); // #! x !#
    s = s.replace(/^#\s*|\s*#$/g, ''); // # x #
    return s.trim();
  };

  // snake / spaced -> camelCase (#customer_city# -> customerCity),
  // matching the camelCase names joud.chat expects in send keys.
  const toCamel = (s) =>
    String(s)
      .trim()
      .replace(/[\s_-]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
      .replace(/^[A-Z]/, (c) => c.toLowerCase());

  // index (1-based) -> { name, index, section }
  const byIndex = new Map();
  const addAt = (rawIdx, rawName, section) => {
    const idx = parseInt(rawIdx, 10);
    if (!Number.isFinite(idx) || idx <= 0) return;
    const nm = cleanVarName(rawName);
    if (!nm) return;
    if (!byIndex.has(idx)) byIndex.set(idx, { name: nm, index: idx, section });
  };

  // 1. Authoritative source: variable_map. Each section may be an
  //    ARRAY (positional) OR an OBJECT keyed by the 1-based index,
  //    e.g. {"1":"#!storeName!#","2":"#!customerName!#", ...}.
  for (const sec of ['header', 'body', 'button', 'footer']) {
    const val = variableMap[sec];
    if (!val) continue;
    if (Array.isArray(val)) {
      val.forEach((v, i) => addAt(i + 1, v, sec));
    } else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) addAt(k, v, sec);
    }
  }

  // 2. Friendly names for indices variable_map did NOT name
  //    (e.g. {{10}} {{11}} {{12}}), from the template_json example
  //    body_text array (positional, authoritative for the full count).
  const components = Array.isArray(templateJson.components)
    ? templateJson.components
    : [];
  const bodyComp = components.find((c) => c && c.type === 'body');
  const exampleRow =
    bodyComp &&
    bodyComp.example &&
    Array.isArray(bodyComp.example.body_text) &&
    Array.isArray(bodyComp.example.body_text[0])
      ? bodyComp.example.body_text[0]
      : [];

  // 3. Scan body/header text for {{N}} placeholders not yet covered
  //    (this is what finally catches city / governorate / image).
  for (const text of [body, header]) {
    if (!text || typeof text !== 'string') continue;
    let m;
    const re = /\{\{\s*(\d+)\s*\}\}/g;
    while ((m = re.exec(text)) !== null) {
      const idx = parseInt(m[1], 10);
      if (byIndex.has(idx)) continue;
      const ex = exampleRow[idx - 1]; // e.g. "#customer_city#"
      const friendly = ex ? toCamel(cleanVarName(ex)) : `var${idx}`;
      addAt(idx, friendly, 'body');
    }
  }

  // 4. Last-resort fallback: no variable_map and no {{N}} — scan
  //    the body for #!name!# tokens in order.
  if (byIndex.size === 0) {
    let i = 0;
    for (const m of String(body).matchAll(/#!\s*([^!]+?)\s*!#/g)) {
      addAt(++i, m[1], 'body');
    }
  }

  const variables = [...byIndex.values()].sort((a, b) => a.index - b.index);

  // ---- quick-reply buttons ----
  // button_content may be an array OR { type:'buttons', buttons:[...] }.
  let buttonsArr = [];
  if (Array.isArray(buttonContent)) buttonsArr = buttonContent;
  else if (buttonContent && Array.isArray(buttonContent.buttons))
    buttonsArr = buttonContent.buttons;
  const quickReplyButtons = buttonsArr
    .filter(
      (b) => b && String(b.type || b.button_type || '').toLowerCase().includes('quick')
    )
    .map((b) => b.text || b.title || b.value || '');

  return {
    templateId,
    joudId,
    name,
    type: raw.template_type || 'single',
    locale: raw.locale || '',
    status: raw.status || '',
    body,
    header,
    footer,
    variables,
    quickReplyButtons,
    raw,
  };
}

// ------------------------------------------------------------
//  listTemplates(phoneNumberId) -> [parsedTemplate, ...]
//  GET https://joud.chat/api/v1/whatsapp/template/list
//  Handles `message` being a single object OR an array.
// ------------------------------------------------------------
export async function listTemplates(phoneNumberId) {
  const pnid = phoneNumberId || config.joud.phoneNumberId;
  const url =
    `${config.joud.baseUrl}/whatsapp/template/list` +
    `?apiToken=${encodeURIComponent(config.joud.apiToken)}` +
    `&phone_number_id=${encodeURIComponent(pnid)}`;

  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  const text = await res.text();
  const json = safeJsonParse(text, null);

  if (!res.ok) {
    throw new Error(`joud.chat template/list HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!json) {
    throw new Error(`joud.chat template/list returned non-JSON: ${text.slice(0, 500)}`);
  }

  // `message` may be: a single template object, an array of templates,
  // or (on error) a string. Normalize to an array.
  const message = json.message;
  let rawList = [];
  if (Array.isArray(message)) {
    rawList = message;
  } else if (message && typeof message === 'object') {
    rawList = [message];
  } else if (Array.isArray(json.data)) {
    rawList = json.data;
  } else {
    // status not 1 or unexpected shape.
    throw new Error(
      `joud.chat template/list unexpected response: ${JSON.stringify(json).slice(0, 500)}`
    );
  }

  return rawList
    .map((t) => parseTemplate(t))
    .filter((t) => t && t.templateId);
}

// ------------------------------------------------------------
//  sendTemplate({ phoneNumberId, templateId, variables,
//                 quickReplyValues, phoneNumber })
//
//  variables: ordered array [{ name, index }] OR plain object
//             { name: value }. We build the joud.chat field keys
//             `templateVariable-<name>-<index>` using the index from
//             the template definition so positions stay correct.
// ------------------------------------------------------------
export async function sendTemplate({
  phoneNumberId,
  templateId,
  variableDefs = [], // [{ name, index }]
  values = {}, // { name: resolvedValue }
  quickReplyValues = [],
  phoneNumber,
}) {
  if (!templateId) throw new Error('sendTemplate: templateId is required');
  if (!phoneNumber) throw new Error('sendTemplate: phoneNumber is required');

  const form = new URLSearchParams();
  form.set('apiToken', config.joud.apiToken);
  form.set('phone_number_id', String(phoneNumberId || config.joud.phoneNumberId));
  form.set('template_id', String(templateId));
  form.set('phone_number', String(phoneNumber));

  // Quick reply button values (only if present).
  if (Array.isArray(quickReplyValues) && quickReplyValues.length > 0) {
    form.set('template_quick_reply_button_values', JSON.stringify(quickReplyValues));
  } else {
    form.set('template_quick_reply_button_values', '[]');
  }

  // Build one field per variable: templateVariable-<name>-<index>
  for (const def of variableDefs) {
    const val = values[def.name];
    form.set(
      `templateVariable-${def.name}-${def.index}`,
      val == null ? '' : String(val)
    );
  }

  const url = `${config.joud.baseUrl}/whatsapp/send/template`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });

  const text = await res.text();
  const json = safeJsonParse(text, null);

  // Success heuristic: HTTP 200 AND (status "1" OR a success-ish message).
  let success = false;
  if (res.ok) {
    if (json) {
      const status = String(json.status ?? '');
      const msg = typeof json.message === 'string' ? json.message.toLowerCase() : '';
      success =
        status === '1' ||
        status.toLowerCase() === 'success' ||
        msg.includes('successfully') ||
        msg.includes('generated successfully');
    } else {
      // Non-JSON 200 with a success phrase.
      success = /success/i.test(text);
    }
  }

  return {
    success,
    httpStatus: res.status,
    raw: text,
    parsed: json,
  };
}

export default { parseTemplate, listTemplates, sendTemplate, safeJsonParse };
