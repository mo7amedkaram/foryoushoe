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

  const headerComp =
    components.find((c) => c && String(c.type).toUpperCase() === 'HEADER') ||
    null;
  // HEADER.format is IMAGE | TEXT | VIDEO | DOCUMENT when present.
  const headerFormat = headerComp
    ? String(headerComp.format || headerComp.type || '').toUpperCase()
    : '';
  const requiresImageHeader = headerFormat === 'IMAGE';

  const buttonsComp =
    components.find((c) => c && String(c.type).toUpperCase() === 'BUTTONS') ||
    null;
  const rawButtons =
    buttonsComp && Array.isArray(buttonsComp.buttons) ? buttonsComp.buttons : [];
  const urlButtons = rawButtons
    .map((b, i) => ({
      index: String(i),
      text: b && b.text ? String(b.text) : '',
      url: b && b.url ? String(b.url) : '',
      hasVariable: /\{\{\s*\d+\s*\}\}/.test(String((b && b.url) || '')),
      raw: b,
    }))
    .filter(
      (b) =>
        b.raw &&
        String(b.raw.type || '').toUpperCase() === 'URL'
    );

  return {
    name: raw.name,
    language: raw.language || 'en',
    status: raw.status || '',
    parameterFormat: raw.parameter_format || 'POSITIONAL',
    body: bodyText,
    headerFormat,
    requiresImageHeader,
    variables,
    bodyParamCount: maxIndex,
    urlButtons,
    raw,
  };
}

// Shopify CDN and many storefronts emit protocol-relative image URLs
// ("//cdn.shopify.com/..."). Meta only accepts absolute http(s) links.
export function normalizeImageUrl(input) {
  if (input == null) return '';
  let s = String(input).trim();
  if (!s) return '';
  if (s.startsWith('//')) s = `https:${s}`;
  // Rare absolute-without-scheme forms from some feeds.
  if (/^cdn\.shopify\.com\//i.test(s) || /^[\w.-]+\.myshopify\.com\//i.test(s)) {
    s = `https://${s}`;
  }
  if (!/^https?:\/\//i.test(s)) return '';
  // Drop accidental whitespace/newlines that break the Graph API.
  s = s.replace(/[\r\n\t\s]+/g, '');
  return s;
}

// WhatsApp template IMAGE headers are most reliable with JPEG/PNG.
// Many product assets are stored as .webp on Shopify CDN; Meta has
// returned 132012 ("expected IMAGE, received UNKNOWN") for some of
// those. Force Shopify's image service to emit PNG when possible.
export function toMetaSafeImageUrl(input) {
  let s = normalizeImageUrl(input);
  if (!s) return '';
  const isShopifyCdn =
    /cdn\.shopify\.com\//i.test(s) ||
    /\/cdn\/shop\//i.test(s) ||
    /\.myshopify\.com\//i.test(s);
  // Prefer PNG for Shopify-hosted images (incl. webp sources). Meta
  // template IMAGE headers accept PNG reliably; Shopify CDN re-encodes
  // via ?format=png.
  if (isShopifyCdn) {
    try {
      const u = new URL(s);
      u.searchParams.delete('format');
      u.searchParams.set('format', 'png');
      if (!u.searchParams.has('width')) u.searchParams.set('width', '1200');
      s = u.toString();
    } catch {
      s = s.includes('?') ? `${s}&format=png` : `${s}?format=png`;
    }
  }
  return s;
}

// Download a public image and upload it to Meta's media endpoint so the
// template header can use a media id (avoids Meta failing to fetch
// some CDN / webp links). Returns { ok, mediaId } or { ok:false }.
export async function uploadImageToMeta(imageUrl) {
  const link = toMetaSafeImageUrl(imageUrl) || normalizeImageUrl(imageUrl);
  if (!link || !isMetaConfigured()) {
    return { ok: false, error: 'Missing image URL or Meta config.' };
  }
  let bin;
  let contentType = 'image/png';
  try {
    const imgRes = await fetchWithTimeout(link, { method: 'GET' }, 20000);
    if (!imgRes.ok) {
      return { ok: false, error: `Image fetch HTTP ${imgRes.status}` };
    }
    const ct = String(imgRes.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('png')) contentType = 'image/png';
    else if (ct.includes('jpeg') || ct.includes('jpg')) contentType = 'image/jpeg';
    else if (ct.includes('webp')) {
      return { ok: false, error: 'Image is still webp after conversion attempt.' };
    } else if (ct.startsWith('image/')) contentType = ct.split(';')[0];
    bin = Buffer.from(await imgRes.arrayBuffer());
    if (!bin.length || bin.length > 5 * 1024 * 1024) {
      return { ok: false, error: `Image size invalid (${bin.length} bytes).` };
    }
  } catch (err) {
    return { ok: false, error: `Image fetch failed: ${err.message}` };
  }

  const ext = contentType.includes('png')
    ? 'png'
    : contentType.includes('jpeg') || contentType.includes('jpg')
      ? 'jpg'
      : 'bin';
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', contentType);
  form.append('file', new Blob([bin], { type: contentType }), `header.${ext}`);

  try {
    const res = await fetchWithTimeout(
      `${graphBase()}/${config.meta.phoneNumberId}/media`,
      {
        method: 'POST',
        headers: authHeader(),
        body: form,
      },
      30000
    );
    const text = await res.text().catch(() => '');
    const json = safeJsonParse(text, null);
    if (!res.ok || !json || !json.id) {
      return {
        ok: false,
        error:
          (json && json.error && json.error.message) ||
          `Media upload HTTP ${res.status}: ${String(text).slice(0, 200)}`,
      };
    }
    return {
      ok: true,
      mediaId: String(json.id),
      contentType,
      bytes: bin.length,
      sourceUrl: link,
    };
  } catch (err) {
    return { ok: false, error: `Media upload failed: ${err.message}` };
  }
}

function isImageHeaderError(rawOrError) {
  const s = String(rawOrError || '');
  return (
    /132012/.test(s) ||
    /expected IMAGE/i.test(s) ||
    /header:\s*Format mismatch/i.test(s) ||
    /Parameter format does not match/i.test(s)
  );
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
function buildTemplatePayload({
  to,
  templateName,
  langCode,
  texts,
  headerImageUrl,
  headerImageMediaId = '',
  requireImageHeader,
  buttonUrlText,
  buttonUrlIndex,
}) {
  const parameters = texts.map((t) => ({ type: 'text', text: t }));
  const components = [];
  const imageLink = toMetaSafeImageUrl(headerImageUrl);
  const mediaId = headerImageMediaId ? String(headerImageMediaId) : '';

  // Templates with an IMAGE header (order_confirm_iamge) MUST receive
  // a header component of type image. Prefer media id (uploaded PNG)
  // over a CDN link — more reliable for former-webp product photos.
  // Omitting the header produces Meta error 132012.
  if (mediaId) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { id: mediaId } }],
    });
  } else if (imageLink) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: imageLink } }],
    });
  } else if (requireImageHeader) {
    // Caller should avoid this path; surface a clear local error
    // instead of a cryptic Meta 132012.
    return {
      error:
        'Template requires an IMAGE header but no usable image URL was provided. ' +
        'Set META_FALLBACK_IMAGE or ensure product images resolve from Shopify.',
    };
  }

  if (parameters.length) {
    components.push({ type: 'body', parameters });
  }
  if (buttonUrlText) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(buttonUrlIndex || '0'),
      parameters: [{ type: 'text', text: sanitizeParam(buttonUrlText) }],
    });
  }

  return {
    payload: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(to),
      type: 'template',
      template: {
        name: templateName,
        language: { code: langCode || 'en' },
        components,
      },
    },
    imageLink,
    mediaId,
  };
}

async function postTemplatePayload(payload) {
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
      parsed: null,
      messageId: null,
      messageStatus: null,
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
    graphError,
  };
}

export async function sendTemplateMessage({
  to,
  templateName,
  languageCode = 'en',
  orderedValues = [],
  headerImageUrl = '',
  fallbackImageUrl = '',
  buttonUrlText = '',
  buttonUrlIndex = '0',
  // When true (default for order_confirm_iamge), always require IMAGE.
  forceImageHeader = null,
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
  let requireImageHeader =
    forceImageHeader == null
      ? // Default: known IMAGE-header confirmation templates.
        /order_confirm/i.test(String(templateName || ''))
      : Boolean(forceImageHeader);

  try {
    const tm = await getTemplateMeta(templateName);
    if (tm && tm.ok && tm.template) {
      if (tm.template.language) langCode = tm.template.language;
      if (tm.template.requiresImageHeader != null) {
        requireImageHeader = Boolean(tm.template.requiresImageHeader);
      } else if (tm.template.headerFormat === 'IMAGE') {
        requireImageHeader = true;
      }
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

  const primary = toMetaSafeImageUrl(headerImageUrl);
  const fallback = toMetaSafeImageUrl(
    fallbackImageUrl || config.meta.fallbackImage || ''
  );
  // Prefer product image; fall back to META_FALLBACK_IMAGE so IMAGE
  // templates never go out without a header component.
  let imageToUse = primary || fallback;

  if (requireImageHeader && !imageToUse) {
    return {
      success: false,
      httpStatus: 0,
      raw:
        'Template requires IMAGE header but no product image or META_FALLBACK_IMAGE is available.',
      messageId: null,
      headerImageUsed: '',
    };
  }

  // Prefer uploaded PNG media id for IMAGE headers (webp→png via
  // Shopify CDN + re-upload to Meta). Fall back to link if upload fails.
  let mediaId = '';
  let mediaSource = '';
  if (requireImageHeader && imageToUse) {
    const up = await uploadImageToMeta(imageToUse);
    if (up.ok && up.mediaId) {
      mediaId = up.mediaId;
      mediaSource = up.sourceUrl || imageToUse;
    } else if (fallback && fallback !== imageToUse) {
      const up2 = await uploadImageToMeta(fallback);
      if (up2.ok && up2.mediaId) {
        mediaId = up2.mediaId;
        mediaSource = up2.sourceUrl || fallback;
        imageToUse = fallback;
      }
    }
  }

  const built = buildTemplatePayload({
    to,
    templateName,
    langCode,
    texts,
    headerImageUrl: imageToUse,
    headerImageMediaId: mediaId,
    requireImageHeader,
    buttonUrlText,
    buttonUrlIndex,
  });
  if (built.error) {
    return {
      success: false,
      httpStatus: 0,
      raw: built.error,
      messageId: null,
      headerImageUsed: '',
    };
  }

  let result = await postTemplatePayload(built.payload);
  result.headerImageUsed = mediaSource || built.imageLink || '';
  result.headerMediaId = mediaId || null;

  // If Meta rejects the product image (404/unsupported format/size),
  // retry once with the configured fallback image when different.
  if (
    !result.success &&
    requireImageHeader &&
    fallback &&
    fallback !== imageToUse &&
    isImageHeaderError(result.raw)
  ) {
    let fbMediaId = '';
    const upFb = await uploadImageToMeta(fallback);
    if (upFb.ok) fbMediaId = upFb.mediaId || '';
    const retry = buildTemplatePayload({
      to,
      templateName,
      langCode,
      texts,
      headerImageUrl: fallback,
      headerImageMediaId: fbMediaId,
      requireImageHeader: true,
      buttonUrlText,
      buttonUrlIndex,
    });
    if (!retry.error) {
      const second = await postTemplatePayload(retry.payload);
      second.headerImageUsed = (upFb && upFb.sourceUrl) || retry.imageLink || '';
      second.headerMediaId = fbMediaId || null;
      second.retriedWithFallback = true;
      second.primaryImageError = result.raw;
      result = second;
    }
  }

  return result;
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
  // Original working path (a5d5bad): send image by public HTTPS link.
  // That is what Meta delivered for inquiry replies. Media-upload is only
  // a fallback if the link is rejected.
  let link = normalizeImageUrl(imageUrl) || toMetaSafeImageUrl(imageUrl);
  if (!to || !link) {
    return {
      success: false,
      httpStatus: 0,
      raw: 'Missing recipient or image URL.',
      messageId: null,
    };
  }

  const image = { link };
  if (caption) image.caption = String(caption).slice(0, 1024);
  let r = await sendRawMessage({ to: String(to), type: 'image', image });
  if (r.success) {
    return { ...r, imageSource: link, mediaId: null };
  }

  // Fallback: re-encode via Shopify format=png + Meta media id.
  const safe = toMetaSafeImageUrl(link) || link;
  const up = await uploadImageToMeta(safe);
  if (up.ok && up.mediaId) {
    const byId = { id: up.mediaId };
    if (caption) byId.caption = String(caption).slice(0, 1024);
    const r2 = await sendRawMessage({
      to: String(to),
      type: 'image',
      image: byId,
    });
    return {
      ...r2,
      imageSource: up.sourceUrl || safe,
      mediaId: up.mediaId,
      linkError: r.raw,
    };
  }

  return {
    ...r,
    imageSource: link,
    mediaId: null,
    uploadError: (up && up.error) || null,
  };
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
  normalizeImageUrl,
  toMetaSafeImageUrl,
  uploadImageToMeta,
  sendTemplateMessage,
};
