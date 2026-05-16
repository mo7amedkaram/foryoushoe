// ============================================================
//  src/meta.js
//  Direct Meta WhatsApp Cloud API client.
//
//  We send template messages straight to Meta's Graph API instead
//  of going through joud.chat. This removes the joud.chat
//  variable_map limitation (it only mapped 9 of the 12 template
//  variables) — here WE control all positional parameters.
//
//  Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/
//  Node 22 global fetch; every call has a hard ~15s timeout and is
//  defensive (never throws raw to the caller).
// ============================================================
import { config } from './config.js';

const TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safeJsonParse(text, fallback = null) {
  if (text == null) return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(String(text));
  } catch {
    return fallback;
  }
}

function graphBase() {
  const v = config.meta.apiVersion || 'v22.0';
  return `https://graph.facebook.com/${v}`;
}

function authHeader() {
  return { Authorization: `Bearer ${config.meta.accessToken}` };
}

export function isMetaConfigured() {
  return Boolean(config.meta.accessToken && config.meta.phoneNumberId);
}

// snake_case / spaced -> camelCase  (#customer_city# -> customerCity)
function toCamel(s) {
  return String(s)
    .trim()
    .replace(/[\s_-]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

// ------------------------------------------------------------
//  getPhoneNumbers() -> { ok, numbers:[{id,display,verified_name}] }
//  Lists the phone numbers under the WABA so the UI can show which
//  number messages are sent from.
// ------------------------------------------------------------
export async function getPhoneNumbers() {
  if (!config.meta.accessToken || !config.meta.wabaId) {
    return { ok: false, error: 'META_ACCESS_TOKEN / META_WABA_ID not set.' };
  }
  let res;
  try {
    res = await fetchWithTimeout(
      `${graphBase()}/${config.meta.wabaId}/phone_numbers`,
      { headers: authHeader() }
    );
  } catch (err) {
    return { ok: false, error: `Request failed: ${err.message}` };
  }
  const json = safeJsonParse(await res.text().catch(() => ''), null);
  if (!res.ok || !json || json.error) {
    return {
      ok: false,
      error:
        (json && json.error && json.error.message) ||
        `HTTP ${res.status}`,
    };
  }
  const numbers = (json.data || []).map((n) => ({
    id: n.id,
    display: n.display_phone_number,
    verified_name: n.verified_name,
    quality: n.quality_rating,
  }));
  return { ok: true, numbers };
}

// ------------------------------------------------------------
//  parseMetaTemplate(raw) -> normalized template
//  { name, language, status, parameterFormat, body,
//    variables:[{ index, name }], bodyParamCount }
//
//  POSITIONAL templates: variable names come from the example
//  body_text array (#store_name# -> storeName), index = position.
// ------------------------------------------------------------
export function parseMetaTemplate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const components = Array.isArray(raw.components) ? raw.components : [];
  const body = components.find((c) => c && c.type === 'BODY') || null;
  const bodyText = (body && body.text) || '';

  const placeholders = (bodyText.match(/\{\{\s*(\d+)\s*\}\}/g) || []).map((m) =>
    parseInt(m.replace(/[^\d]/g, ''), 10)
  );
  const maxIndex = placeholders.length ? Math.max(...placeholders) : 0;

  const example =
    body &&
    body.example &&
    Array.isArray(body.example.body_text) &&
    Array.isArray(body.example.body_text[0])
      ? body.example.body_text[0]
      : [];

  const variables = [];
  for (let i = 1; i <= maxIndex; i++) {
    const ex = example[i - 1];
    const name = ex ? toCamel(String(ex).replace(/^#|#$/g, '')) : `var${i}`;
    variables.push({ index: i, name });
  }

  return {
    name: raw.name,
    language: raw.language || 'en',
    status: raw.status || '',
    parameterFormat: raw.parameter_format || 'POSITIONAL',
    body: bodyText,
    variables,
    bodyParamCount: maxIndex,
    raw,
  };
}

// ------------------------------------------------------------
//  listTemplatesMeta() -> { ok, templates:[parsedMetaTemplate] }
// ------------------------------------------------------------
export async function listTemplatesMeta() {
  if (!config.meta.accessToken || !config.meta.wabaId) {
    return { ok: false, error: 'META_ACCESS_TOKEN / META_WABA_ID not set.' };
  }
  let res;
  try {
    res = await fetchWithTimeout(
      `${graphBase()}/${config.meta.wabaId}/message_templates` +
        `?fields=name,status,language,category,parameter_format,components&limit=100`,
      { headers: authHeader() }
    );
  } catch (err) {
    return { ok: false, error: `Request failed: ${err.message}` };
  }
  const json = safeJsonParse(await res.text().catch(() => ''), null);
  if (!res.ok || !json || json.error) {
    return {
      ok: false,
      error:
        (json && json.error && json.error.message) || `HTTP ${res.status}`,
    };
  }
  const templates = (json.data || [])
    .map((t) => parseMetaTemplate(t))
    .filter(Boolean);
  return { ok: true, templates };
}

export async function getTemplateMeta(name) {
  const r = await listTemplatesMeta();
  if (!r.ok) return r;
  const tpl = r.templates.find(
    (t) => String(t.name) === String(name) && t.status === 'APPROVED'
  ) || r.templates.find((t) => String(t.name) === String(name));
  return tpl
    ? { ok: true, template: tpl }
    : { ok: false, error: `Template "${name}" not found on Meta.` };
}

// WhatsApp body text parameters cannot be empty and cannot contain
// newlines, tabs, or more than 4 consecutive spaces. Sanitize so a
// real order value never gets the whole message rejected by Meta.
function sanitizeParam(value) {
  let s = value == null ? '' : String(value);
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  if (s === '') s = '-'; // Meta rejects empty parameters
  return s;
}

// WhatsApp rejects a template message whose FINAL rendered body
// exceeds 1024 chars (error 132005 "Translated text too long").
// The fixed template text is constant; only the params vary. When
// the total would overflow, trim the longest FREE-TEXT params first
// (addresses, description) — never URLs or short critical fields —
// so short orders stay byte-identical and long ones still deliver.
function fitParamsToBodyLimit(texts, fixedLen, { max = 1024, margin = 24 } = {}) {
  const limit = max - margin;
  const sum = (a) => a.reduce((n, s) => n + s.length, 0);
  const out = texts.slice();
  let total = fixedLen + sum(out);
  if (total <= limit) return out; // unchanged — identical to before

  const isUrl = (s) => /^https?:\/\//i.test(s);
  const order = out
    .map((s, i) => ({ i, len: s.length }))
    .filter((x) => !isUrl(out[x.i]) && out[x.i].length > 16)
    .sort((a, b) => b.len - a.len)
    .map((x) => x.i);

  for (const i of order) {
    if (total <= limit) break;
    const cur = out[i];
    const minKeep = 12;
    const need = total - limit;
    const canCut = Math.max(0, cur.length - minKeep);
    const cut = Math.min(canCut, need + 1); // +1 for the ellipsis
    if (cut <= 0) continue;
    out[i] = cur.slice(0, cur.length - cut - 1).trimEnd() + '…';
    total = fixedLen + sum(out);
  }
  return out;
}

// ------------------------------------------------------------
//  sendTemplateMessage({ to, templateName, languageCode,
//                        orderedValues })
//
//  orderedValues: array of resolved strings in placeholder order
//  (index 1 .. N). Sent as POSITIONAL body parameters. Static
//  buttons (quick_reply / url with no variables) need no component.
//
//  Returns { success, httpStatus, raw, parsed, messageId }.
//  Never throws.
// ------------------------------------------------------------
export async function sendTemplateMessage({
  to,
  templateName,
  languageCode = 'en',
  orderedValues = [],
  headerImageUrl = '',
}) {
  if (!isMetaConfigured()) {
    return {
      success: false,
      httpStatus: 0,
      raw: 'META not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).',
    };
  }
  if (!to) {
    return { success: false, httpStatus: 0, raw: 'Missing recipient phone.' };
  }
  if (!templateName) {
    return { success: false, httpStatus: 0, raw: 'Missing template name.' };
  }

  let texts = orderedValues.map((v) => sanitizeParam(v));
  // Keep the rendered body under WhatsApp's 1024-char limit by
  // trimming only the longest free-text params when necessary. Also
  // self-correct the language code from the live template so a
  // mismatched META_TEMPLATE_LANG can't fail every send (132001).
  let langCode = languageCode || 'en';
  try {
    const tm = await getTemplateMeta(templateName);
    if (tm && tm.ok && tm.template) {
      if (tm.template.language) langCode = tm.template.language;
      if (tm.template.body) {
        const fixed = String(tm.template.body).replace(
          /\{\{\s*\d+\s*\}\}/g,
          ''
        );
        texts = fitParamsToBodyLimit(texts, fixed.length);
      }
    }
  } catch {
    /* best effort — send unfitted if the template fetch fails */
  }

  const parameters = texts.map((t) => ({ type: 'text', text: t }));

  const components = [];
  // IMAGE header (e.g. order_confirm_iamge): the product photo.
  if (headerImageUrl && /^https?:\/\//i.test(String(headerImageUrl))) {
    components.push({
      type: 'header',
      parameters: [
        { type: 'image', image: { link: String(headerImageUrl) } },
      ],
    });
  }
  if (parameters.length) {
    components.push({ type: 'body', parameters });
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: langCode || 'en' },
      components,
    },
  };

  const url = `${graphBase()}/${config.meta.phoneNumberId}/messages`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        ...authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      success: false,
      httpStatus: 0,
      raw: `Send request failed: ${err.message}`,
    };
  }

  const text = await res.text().catch(() => '');
  const json = safeJsonParse(text, null);

  const msg0 = json && json.messages && json.messages[0];
  const messageId = msg0 && msg0.id;
  // Meta can return HTTP 200 with an embedded { error: {...} } object
  // (rare for /messages but possible for pacing / policy notices) and
  // also returns a per-message `message_status`. "accepted" means the
  // payload was queued — it is NOT a delivery guarantee, but it IS the
  // correct success criterion for the send call itself. Anything other
  // than accepted/sent/delivered/read on the send response is treated
  // as a failure so it is not silently logged as success.
  const graphError = json && json.error ? json.error : null;
  const msgStatus = msg0 && msg0.message_status;
  const statusOk =
    !msgStatus ||
    ['accepted', 'sent', 'delivered', 'read'].includes(
      String(msgStatus).toLowerCase()
    );
  const success = Boolean(res.ok && messageId && !graphError && statusOk);

  return {
    success,
    httpStatus: res.status,
    raw: graphError
      ? `graph error ${graphError.code || '?'}: ${
          graphError.message || ''
        } :: ${text}`
      : text,
    parsed: json,
    messageId: messageId || null,
    messageStatus: msgStatus || null,
  };
}

// ------------------------------------------------------------
//  Free-form session messages (image / text).
//
//  These only deliver inside the 24h customer-service window —
//  i.e. AFTER the customer has messaged us (e.g. tapped a template
//  quick-reply button). Used to send the remaining product images
//  and confirmation replies. Never throws.
// ------------------------------------------------------------
async function sendRawMessage(payload) {
  if (!isMetaConfigured()) {
    return { success: false, httpStatus: 0, raw: 'META not configured.' };
  }
  const url = `${graphBase()}/${config.meta.phoneNumberId}/messages`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...payload,
      }),
    });
  } catch (err) {
    return { success: false, httpStatus: 0, raw: `request failed: ${err.message}` };
  }
  const text = await res.text().catch(() => '');
  const json = safeJsonParse(text, null);
  const msg0 = json && json.messages && json.messages[0];
  const graphError = json && json.error ? json.error : null;
  return {
    success: Boolean(res.ok && msg0 && msg0.id && !graphError),
    httpStatus: res.status,
    raw: graphError
      ? `graph error ${graphError.code || '?'}: ${graphError.message || ''}`
      : text,
    messageId: (msg0 && msg0.id) || null,
  };
}

export async function sendImageMessage({ to, imageUrl, caption = '' }) {
  if (!to || !/^https?:\/\//i.test(String(imageUrl || ''))) {
    return { success: false, httpStatus: 0, raw: 'Missing recipient or image URL.' };
  }
  const image = { link: String(imageUrl) };
  if (caption) image.caption = String(caption).slice(0, 1024);
  return sendRawMessage({ to: String(to), type: 'image', image });
}

export async function sendTextMessage({ to, text }) {
  if (!to || !text) {
    return { success: false, httpStatus: 0, raw: 'Missing recipient or text.' };
  }
  return sendRawMessage({
    to: String(to),
    type: 'text',
    text: { body: String(text).slice(0, 4096), preview_url: false },
  });
}

export default {
  isMetaConfigured,
  getPhoneNumbers,
  sendImageMessage,
  sendTextMessage,
  listTemplatesMeta,
  getTemplateMeta,
  parseMetaTemplate,
  sendTemplateMessage,
};
