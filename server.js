// ============================================================
//  server.js
//  Express app: serves the single-page UI + JSON API + the
//  Shopify webhook (with raw-body HMAC verification).
// ============================================================
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { config } from './src/config.js';
import {
  isSupabaseEnabled,
  getConfig,
  saveConfig,
  insertLog,
  listLogs,
  listLogsPaged,
  successfulOrderIdSet,
  hasSuccessfulLog,
  findRecentOrderByPhone,
  getShopifyAuth,
  saveShopifyAuth,
} from './src/supabase.js';
import { listTemplates } from './src/joud.js';
import {
  isMetaConfigured,
  sendTemplateMessage as metaSendTemplate,
  sendImageMessage as metaSendImage,
  sendTextMessage as metaSendText,
  getPhoneNumbers as metaGetPhoneNumbers,
  listTemplatesMeta,
} from './src/meta.js';
import {
  verifyWebhookHmac,
  resolvers,
  resolverOptions,
  resolveVariablesForOrder,
  pickRecipientPhone,
  normalizePhone,
} from './src/shopify.js';
import {
  isValidShop,
  buildInstallUrl,
  verifyOAuthHmac,
  exchangeCodeForToken,
  getClientCredentialsToken,
  fetchLatestOrder,
  fetchOrderById,
  confirmShopifyOrder,
  getOrderItemsDetailed,
  enrichOrderFromShopify,
  adminApiGet,
  CONFIRM_TAG,
  OAUTH_SCOPES,
} from './src/shopifyOAuth.js';
import { buildSampleOrder } from './src/sampleOrder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');

// ------------------------------------------------------------
//  Body parsing
//
//  IMPORTANT: the Shopify webhook needs the RAW request body to
//  compute the HMAC. We register a raw parser ONLY for that route
//  and JSON/urlencoded parsers for everything else.
// ------------------------------------------------------------
app.use('/webhooks/shopify/orders-create', express.raw({ type: '*/*', limit: '2mb' }));
app.use(
  express.json({
    limit: '1mb',
    // Retain raw bytes so the WhatsApp webhook can verify Meta's
    // X-Hub-Signature-256 (HMAC of the exact payload, App Secret key).
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Static single-page UI
app.use(express.static(path.join(__dirname, 'public')));

// Small async wrapper so a thrown error never crashes the process.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[error] ${req.method} ${req.path}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message || 'Internal error' });
    }
  });

// ------------------------------------------------------------
//  Tiny cookie helpers (no extra dependency).
//  Used only to carry the OAuth nonce/state between /auth and
//  /auth/callback. httpOnly + SameSite=Lax so it survives the
//  Shopify redirect back to us.
// ------------------------------------------------------------
const OAUTH_STATE_COOKIE = 'shopify_oauth_state';

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function setCookie(res, name, value, { maxAgeSec = 600 } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.append(
    'Set-Cookie',
    `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

// Constant-time string comparison (length-safe).
function timingSafeStrEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// Verify Meta's X-Hub-Signature-256 on the inbound WhatsApp webhook.
// The header is `sha256=<hex HMAC-SHA256(rawBody, META_APP_SECRET)>`.
// Enforced ONLY when META_APP_SECRET is set (so local dev still works);
// when unset we log a one-time warning and allow the request.
let _warnedNoAppSecret = false;
function verifyMetaSignature(req) {
  const secret = config.security.metaAppSecret;
  if (!secret) {
    if (!_warnedNoAppSecret) {
      console.warn(
        '[webhooks/whatsapp] META_APP_SECRET not set — inbound webhook ' +
          'is UNVERIFIED. Set it before exposing this server publicly.'
      );
      _warnedNoAppSecret = true;
    }
    return true;
  }
  const header = req.get('x-hub-signature-256') || '';
  const provided = header.startsWith('sha256=') ? header.slice(7) : '';
  if (!provided || !req.rawBody || !req.rawBody.length) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');
  return timingSafeStrEqual(expected, provided);
}

// Build the redirect_uri this server expects Shopify to call back on.
// Honors X-Forwarded-* so it works behind a cloudflared / ngrok tunnel.
function buildRedirectUri(req) {
  const proto =
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    req.protocol ||
    'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return `${proto}://${host}/auth/callback`;
}

// The natural 1:1 mapping: template variable name -> resolver id.
// The active Meta template (order_confirm_iamge) has 11 body
// variables, themselves named after resolver ids (storeName,
// customerName, ...); the legacy 12-var template additionally has
// orderPhoto which maps to the productImage resolver.
function suggestResolverId(varName) {
  if (varName === 'orderPhoto') return 'productImage';
  return resolvers[varName] ? varName : '';
}

function buildSuggestedMapping(variables) {
  const m = {};
  for (const v of variables) {
    const rid = suggestResolverId(v.name);
    if (rid) m[v.name] = { type: 'resolver', value: rid };
  }
  return m;
}

// Trim a raw Shopify order down to the fields the UI needs (avoids
// dumping a huge payload / unnecessary PII into the browser).
function trimOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const addr = (a) =>
    a && typeof a === 'object'
      ? {
          name: a.name || '',
          address1: a.address1 || '',
          address2: a.address2 || '',
          city: a.city || '',
          province: a.province || '',
          country: a.country || '',
          zip: a.zip || '',
          phone: a.phone || '',
        }
      : null;
  return {
    id: order.id,
    name: order.name,
    order_number: order.order_number,
    created_at: order.created_at,
    currency: order.currency,
    total_price: order.total_price,
    financial_status: order.financial_status,
    fulfillment_status: order.fulfillment_status,
    phone: order.phone || '',
    customer: order.customer
      ? {
          first_name: order.customer.first_name || '',
          last_name: order.customer.last_name || '',
          phone: order.customer.phone || '',
          email: order.customer.email || '',
        }
      : null,
    line_items: Array.isArray(order.line_items)
      ? order.line_items.map((li) => ({
          title: li.title || li.name || '',
          quantity: li.quantity || 1,
        }))
      : [],
    shipping_address: addr(order.shipping_address),
    billing_address: addr(order.billing_address),
  };
}

// The 12 template variables (id + phone_number_id) this app targets.
const ORDER_CONFIRM_TEMPLATE_ID = '2094622431108343';
const ORDER_CONFIRM_PHONE_NUMBER_ID = '1115965254927153';

// ------------------------------------------------------------
//  Admin guard — protects mutating / token-minting / message-
//  sending routes. Enforced ONLY when ADMIN_UI_TOKEN is set, so
//  local dev keeps working; in production set ADMIN_UI_TOKEN and
//  send it as the `x-admin-token` header (or ?admin_token=).
// ------------------------------------------------------------
const ADMIN_GUARDED = [
  ['POST', '/api/config'],
  ['POST', '/api/test-send'],
  ['POST', '/api/shopify/generate-token'],
  ['POST', '/api/shopify/test-last-order'],
  ['POST', '/api/orders/send-all'],
  // Per-order manual send: matched by prefix (the :id is dynamic) in
  // the guard below, so it is intentionally NOT a static entry here.
];
// Dynamic guarded matcher for routes with a path param.
const ADMIN_GUARDED_RE = [
  // POST /api/orders/:id/send  (operator-triggered resend)
  { method: 'POST', re: /^\/api\/orders\/[^/]+\/send$/ },
];
app.use((req, res, next) => {
  const tok = config.security.adminUiToken;
  if (!tok) return next();
  const guarded =
    ADMIN_GUARDED.some(([m, p]) => req.method === m && req.path === p) ||
    ADMIN_GUARDED_RE.some(
      (g) => req.method === g.method && g.re.test(req.path)
    );
  if (!guarded) return next();
  const got = req.get('x-admin-token') || req.query.admin_token || '';
  if (got && timingSafeStrEqual(String(got), tok)) return next();
  return res.status(401).json({ ok: false, error: 'admin token required' });
});

// ------------------------------------------------------------
//  GET /api/health
// ------------------------------------------------------------
app.get(
  '/api/health',
  wrap(async (_req, res) => {
    res.json({
      ok: true,
      supabase: isSupabaseEnabled(),
      time: new Date().toISOString(),
    });
  })
);

// ------------------------------------------------------------
//  GET /api/meta  -> resolver options + defaults for the UI
// ------------------------------------------------------------
app.get(
  '/api/meta',
  wrap(async (_req, res) => {
    res.json({
      ok: true,
      resolvers: resolverOptions(),
      supabaseEnabled: isSupabaseEnabled(),
      shopDomain: config.shopify.shopDomain,
      defaults: config.defaults,
      defaultPhoneNumberId: config.joud.phoneNumberId,
    });
  })
);

// ------------------------------------------------------------
//  GET /api/config  /  POST /api/config
// ------------------------------------------------------------
app.get(
  '/api/config',
  wrap(async (_req, res) => {
    const cfg = await getConfig();
    res.json({ ok: true, config: cfg });
  })
);

app.post(
  '/api/config',
  wrap(async (req, res) => {
    const body = req.body || {};
    const partial = {};

    if (body.settings && typeof body.settings === 'object') {
      partial.settings = {};
      if (body.settings.store_name !== undefined)
        partial.settings.store_name = String(body.settings.store_name);
      if (body.settings.default_country_code !== undefined)
        partial.settings.default_country_code = String(
          body.settings.default_country_code
        ).replace(/\D/g, '');
      if (body.settings.recipient_phone_source !== undefined)
        partial.settings.recipient_phone_source = String(
          body.settings.recipient_phone_source
        );
    }
    if (body.mapping !== undefined && typeof body.mapping === 'object') {
      partial.mapping = body.mapping;
    }
    if (body.selected_template_id !== undefined) {
      partial.selected_template_id = String(body.selected_template_id);
    }
    if (body.phone_number_id !== undefined) {
      partial.phone_number_id = String(body.phone_number_id);
    }

    const saved = await saveConfig(partial);
    res.json({ ok: true, config: saved });
  })
);

// ------------------------------------------------------------
//  GET /api/templates?phone_number_id=
// ------------------------------------------------------------
app.get(
  '/api/templates',
  wrap(async (req, res) => {
    const pnid =
      req.query.phone_number_id ||
      (await getConfig()).phone_number_id ||
      config.joud.phoneNumberId;
    try {
      const templates = await listTemplates(pnid);
      res.json({ ok: true, templates });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message, templates: [] });
    }
  })
);

// ------------------------------------------------------------
//  GET /api/logs?page=&limit=&onlyFailed=1
//
//  Paginated, optionally error-filtered message log (the
//  monitoring view). Backward compatible: when no `page` param is
//  given it still returns the most recent `limit` rows (old shape
//  plus the extra paging fields, which old callers ignore).
// ------------------------------------------------------------
app.get(
  '/api/logs',
  wrap(async (req, res) => {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      100
    );
    const onlyFailed =
      req.query.onlyFailed === '1' ||
      req.query.onlyFailed === 'true' ||
      req.query.onlyFailed === true;

    if (req.query.page === undefined && !onlyFailed) {
      // Legacy behaviour: most recent `limit` rows.
      const logs = await listLogs(limit);
      return res.json({
        ok: true,
        logs,
        page: 1,
        limit,
        total: logs.length,
      });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const r = await listLogsPaged({ page, limit, onlyFailed });
    res.json({
      ok: true,
      logs: r.rows,
      page: r.page,
      limit: r.limit,
      total: r.total,
    });
  })
);

// ============================================================
//  SHOPIFY OAUTH (authorization code grant — OFFLINE token)
// ============================================================

// ------------------------------------------------------------
//  GET /auth[?shop=]
//  Starts the OAuth flow. Sets a signed-ish nonce cookie and
//  302-redirects the merchant's BROWSER to Shopify's authorize URL.
// ------------------------------------------------------------
app.get(
  '/auth',
  wrap(async (req, res) => {
    const shop = String(req.query.shop || config.shopify.shopDomain || '').trim();
    if (!isValidShop(shop)) {
      return res
        .status(400)
        .type('html')
        .send(
          `<h2>Invalid shop domain</h2><p>"${shop}" is not a valid ` +
            `*.myshopify.com domain. Pass ?shop=your-store.myshopify.com ` +
            `or set SHOP_DOMAIN in .env.</p>`
        );
    }

    const state = crypto.randomBytes(24).toString('hex');
    setCookie(res, OAUTH_STATE_COOKIE, state, { maxAgeSec: 600 });

    const redirectUri = buildRedirectUri(req);
    let installUrl;
    try {
      installUrl = buildInstallUrl({ shop, redirectUri, state });
    } catch (err) {
      return res
        .status(400)
        .type('html')
        .send(`<h2>OAuth error</h2><p>${err.message}</p>`);
    }

    console.log(
      `[oauth] redirecting to Shopify authorize for ${shop} ` +
        `(redirect_uri=${redirectUri})`
    );
    return res.redirect(302, installUrl);
  })
);

// ------------------------------------------------------------
//  GET /auth/callback
//  Shopify redirects here with: code, hmac, host, shop, state,
//  timestamp. We verify shop regex + state + query HMAC, exchange
//  the code for the offline token, persist it, then bounce to /.
// ------------------------------------------------------------
app.get(
  '/auth/callback',
  wrap(async (req, res) => {
    const fail = (status, msg) => {
      console.warn(`[oauth] callback rejected: ${msg}`);
      return res
        .status(status)
        .type('html')
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
            `<title>OAuth failed</title></head><body ` +
            `style="font-family:system-ui;max-width:560px;margin:60px auto;` +
            `line-height:1.6;color:#222">` +
            `<h2>Shopify connection failed</h2>` +
            `<p>${msg}</p>` +
            `<p><a href="/auth">Try connecting again</a> · ` +
            `<a href="/">Back to the app</a></p>` +
            `</body></html>`
        );
    };

    const { shop, state, code } = req.query;

    // 1. shop must match the strict regex.
    if (!isValidShop(String(shop || ''))) {
      return fail(400, 'The "shop" parameter is missing or invalid.');
    }

    // 2. state must equal the nonce we stored in the cookie.
    const cookies = parseCookies(req);
    const expectedState = cookies[OAUTH_STATE_COOKIE];
    clearCookie(res, OAUTH_STATE_COOKIE);
    if (!expectedState || !state || !timingSafeStrEqual(String(state), expectedState)) {
      return fail(
        400,
        'State (nonce) mismatch. The request did not originate from this ' +
          'app, or the session expired. Start again from /auth.'
      );
    }

    // 3. HMAC of the query params (hex, sorted, Shopify algorithm).
    if (!verifyOAuthHmac(req.query, config.shopify.apiSecret)) {
      return fail(
        400,
        'HMAC verification failed. The callback could not be authenticated ' +
          'with the app secret.'
      );
    }

    if (!code) {
      return fail(400, 'Missing authorization "code" in the callback.');
    }

    // 4. Exchange the code for the OFFLINE (non-expiring) token.
    const exchanged = await exchangeCodeForToken({ shop: String(shop), code });
    if (!exchanged.ok) {
      return fail(502, `Token exchange failed: ${exchanged.error}`);
    }

    await saveShopifyAuth({
      shop: String(shop),
      access_token: exchanged.access_token,
      scope: exchanged.scope,
    });

    console.log(
      `[oauth] connected ${shop} (scope=${exchanged.scope}); token stored.`
    );
    return res.redirect(302, '/?connected=1');
  })
);

// ------------------------------------------------------------
//  POST /api/shopify/generate-token
//
//  The headless "Generate Access Token" path (Shopify CLIENT
//  CREDENTIALS grant) — mirrors the joud.chat dashboard feature.
//  Body: { store_sub_domain | shop, client_id?, client_secret? }
//  client_id/secret default to .env when omitted. On success the
//  token is persisted (Supabase shopify_auth) and returned so the
//  UI can display it like joud.chat does.
// ------------------------------------------------------------
app.post(
  '/api/shopify/generate-token',
  wrap(async (req, res) => {
    const b = req.body || {};

    // Accept a full domain OR a bare sub-domain ("for-you-shoe-6129").
    let shop = String(
      b.shop || b.store_sub_domain || b.sub_domain || config.shopify.shopDomain || ''
    )
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (shop && !shop.includes('.')) shop = `${shop}.myshopify.com`;

    if (!isValidShop(shop)) {
      return res.status(400).json({
        ok: false,
        error: `Invalid store sub-domain: "${shop}". Use e.g. "for-you-shoe-6129".`,
      });
    }

    const clientId = String(b.client_id || config.shopify.apiKey || '').trim();
    const clientSecret = String(
      b.client_secret || config.shopify.apiSecret || ''
    ).trim();

    const r = await getClientCredentialsToken({ shop, clientId, clientSecret });
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: r.error });
    }

    await saveShopifyAuth({
      shop: r.shop,
      access_token: r.access_token,
      scope: r.scope,
      expires_at: r.expires_at,
    });

    console.log(
      `[shopify] client-credentials token generated for ${r.shop} ` +
        `(scope=${r.scope}, expires_in=${r.expires_in}s).`
    );

    res.json({
      ok: true,
      shop: r.shop,
      access_token: r.access_token,
      scope: r.scope,
      expires_in: r.expires_in,
      expires_at: r.expires_at,
    });
  })
);

// ------------------------------------------------------------
//  GET /api/shopify/status -> connection status
// ------------------------------------------------------------
app.get(
  '/api/shopify/status',
  wrap(async (_req, res) => {
    const auth = await getShopifyAuth();
    const expMs = auth && auth.expires_at ? Date.parse(auth.expires_at) : NaN;
    res.json({
      ok: true,
      connected: Boolean(auth && auth.access_token),
      shop: (auth && auth.shop) || config.shopify.shopDomain || '',
      scope: (auth && auth.scope) || '',
      obtained_at: (auth && auth.obtained_at) || null,
      expires_at: (auth && auth.expires_at) || null,
      expired: Number.isFinite(expMs) ? expMs <= Date.now() : null,
      requiredScopes: OAUTH_SCOPES,
    });
  })
);

// ------------------------------------------------------------
//  GET /api/shopify/last-order
//  Fetches the most recent real order via the stored offline token,
//  then returns the trimmed order + a `preview` of the 12 template
//  variables resolved through the SAVED mapping (or, if none saved,
//  the natural 1:1 auto-mapping) + the suggestedMapping.
// ------------------------------------------------------------
app.get(
  '/api/shopify/last-order',
  wrap(async (_req, res) => {
    const result = await fetchLatestOrder();
    if (!result.ok) {
      const httpStatus =
        result.error === 'NOT_CONNECTED'
          ? 409
          : result.status === 401 || result.status === 403
          ? result.status
          : result.status && result.status >= 400
          ? 502
          : 502;
      return res.status(httpStatus).json({
        ok: false,
        error: result.error || 'FETCH_FAILED',
        message: result.message || 'Could not fetch the latest order.',
      });
    }

    const order = result.order;

    // Enrich (real product image + size/color description) so the
    // preview shows exactly what will be sent.
    try {
      await enrichOrderFromShopify(order);
    } catch {
      /* non-fatal */
    }

    // Load the joud template so we have the canonical 12 variables.
    const cfg = await getConfig();
    const settings = cfg.settings || {};
    const savedMapping =
      cfg.mapping && Object.keys(cfg.mapping).length ? cfg.mapping : null;
    const phoneNumberId =
      cfg.phone_number_id ||
      ORDER_CONFIRM_PHONE_NUMBER_ID ||
      config.joud.phoneNumberId;

    let templateDef = null;
    let templateError = null;
    try {
      const templates = await listTemplates(phoneNumberId);
      templateDef =
        templates.find(
          (t) => String(t.templateId) === String(ORDER_CONFIRM_TEMPLATE_ID)
        ) ||
        templates.find(
          (t) => String(t.templateId) === String(cfg.selected_template_id)
        ) ||
        templates[0] ||
        null;
    } catch (err) {
      templateError = err.message;
    }

    const variables = templateDef ? templateDef.variables : [];
    const suggestedMapping = buildSuggestedMapping(variables);

    // Resolve using the saved mapping if present, otherwise the
    // natural 1:1 auto-mapping (so the user sees real values to review).
    const effectiveMapping = savedMapping || suggestedMapping;
    const { values } = resolveVariablesForOrder(
      order,
      effectiveMapping,
      settings
    );
    const recipientPhone = pickRecipientPhone(order, settings);

    const preview = variables.map((v) => {
      const m =
        (savedMapping && savedMapping[v.name]) ||
        suggestedMapping[v.name] ||
        { type: 'resolver', value: '' };
      return {
        index: v.index,
        name: v.name,
        mappingType: m.type || 'resolver',
        mappingValue: m.value || '',
        resolvedValue: values[v.name] != null ? String(values[v.name]) : '',
      };
    });

    res.json({
      ok: true,
      order: trimOrder(order),
      recipientPhone,
      template: templateDef
        ? {
            templateId: templateDef.templateId,
            name: templateDef.name,
            phoneNumberId,
            variableCount: variables.length,
          }
        : null,
      templateError,
      mappingSource: savedMapping ? 'saved' : 'auto-1:1',
      suggestedMapping,
      savedMapping: savedMapping || {},
      preview,
    });
  })
);

// ============================================================
//  UNCONFIRMED ORDERS — list / send one / send all
// ============================================================

// The exact Shopify fields the unconfirmed list needs (kept small
// to limit PII and payload size).
const UNCONFIRMED_FIELDS =
  'id,name,order_number,created_at,total_price,currency,' +
  'financial_status,fulfillment_status,tags,customer,' +
  'shipping_address,line_items';

// Does this Shopify order already carry the confirm tag?
// tags is a comma-separated string; compare case-insensitively.
function hasConfirmTag(order) {
  return String((order && order.tags) || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .includes(CONFIRM_TAG.toLowerCase());
}

function isCancelledOrder(order) {
  return Boolean(order && order.cancelled_at);
}

// Best-effort recipient phone for the list view (no normalization
// here — just show what Shopify has so the operator can eyeball it).
function listPhone(order) {
  const sa = order && order.shipping_address;
  const c = order && order.customer;
  return (
    (sa && sa.phone) ||
    (c && c.phone) ||
    (order && order.phone) ||
    ''
  );
}

function listCustomerName(order) {
  const c = order && order.customer;
  if (c && (c.first_name || c.last_name)) {
    return `${c.first_name || ''} ${c.last_name || ''}`.trim();
  }
  const sa = order && order.shipping_address;
  return (sa && sa.name) || '';
}

// Fetch recent Shopify orders, drop confirmed/cancelled ones, and
// annotate each with `alreadySent` (a successful message_log row
// exists for that shopify_order_id). Returns the FULL filtered list
// (caller paginates / caps). Degrades gracefully to [] on error.
async function computeUnconfirmedOrders() {
  const result = await adminApiGet(
    'orders.json?status=any&limit=250&order=created_at+desc&fields=' +
      UNCONFIRMED_FIELDS
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || 'FETCH_FAILED',
      message: result.message || 'Could not fetch Shopify orders.',
      status: result.status,
      orders: [],
    };
  }
  const raw = Array.isArray(result.data && result.data.orders)
    ? result.data.orders
    : [];

  const filtered = raw.filter(
    (o) => o && !hasConfirmTag(o) && !isCancelledOrder(o)
  );

  // One query -> Set of order ids that already have a successful send.
  let sentSet = new Set();
  try {
    sentSet = await successfulOrderIdSet(2000);
  } catch {
    sentSet = new Set();
  }

  const orders = filtered.map((o) => ({
    id: o.id,
    name: o.name || `#${o.order_number || o.id}`,
    order_number: o.order_number,
    created_at: o.created_at,
    total_price: o.total_price,
    currency: o.currency,
    customer_name: listCustomerName(o),
    phone: listPhone(o),
    alreadySent: sentSet.has(String(o.id)),
  }));

  return { ok: true, orders };
}

// ------------------------------------------------------------
//  GET /api/orders/unconfirmed?limit=&page=
//  Read-only (kept open, like the other /api/shopify/* reads).
// ------------------------------------------------------------
app.get(
  '/api/orders/unconfirmed',
  wrap(async (req, res) => {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      100
    );
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const r = await computeUnconfirmedOrders();
    if (!r.ok) {
      const code =
        r.error === 'NOT_CONNECTED'
          ? 409
          : r.status === 401 || r.status === 403
          ? r.status
          : 502;
      return res.status(code).json({
        ok: false,
        error: r.error,
        message: r.message,
        page,
        limit,
        total: 0,
        orders: [],
      });
    }

    const total = r.orders.length;
    const from = (page - 1) * limit;
    const slice = r.orders.slice(from, from + limit);
    res.json({
      ok: true,
      page,
      limit,
      total,
      orders: slice,
    });
  })
);

// ------------------------------------------------------------
//  POST /api/orders/:id/send   (ADMIN_GUARDED via regex)
//  Operator-triggered (re)send for a single order. Bypasses
//  idempotency on purpose (explicit operator intent to resend).
// ------------------------------------------------------------
app.post(
  '/api/orders/:id/send',
  wrap(async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res
        .status(400)
        .json({ ok: false, error: 'order id is required' });
    }
    const got = await fetchOrderById(id);
    if (!got.ok) {
      const code =
        got.error === 'NOT_CONNECTED'
          ? 409
          : got.error === 'NOT_FOUND'
          ? 404
          : 502;
      return res.status(code).json({
        ok: false,
        error: got.error || 'NOT_FOUND',
        message: got.message || 'Could not fetch the order from Shopify.',
      });
    }
    const result = await processOrder(got.order, {
      source: 'manual-send',
      skipIdempotency: true,
    });
    res.json({ ok: true, result });
  })
);

// ------------------------------------------------------------
//  POST /api/orders/send-all   (ADMIN_GUARDED)
//  body (optional): { limit }
//  Recompute the unconfirmed list, skip alreadySent, process
//  sequentially with pacing, hard-capped at 50 per call. Never
//  throws; one bad order does not abort the batch.
// ------------------------------------------------------------
const SEND_ALL_HARD_CAP = 50;
const SEND_ALL_DELAY_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post(
  '/api/orders/send-all',
  wrap(async (req, res) => {
    const body = req.body || {};
    const reqLimit = parseInt(body.limit, 10);
    const cap =
      Number.isFinite(reqLimit) && reqLimit > 0
        ? Math.min(reqLimit, SEND_ALL_HARD_CAP)
        : SEND_ALL_HARD_CAP;

    const r = await computeUnconfirmedOrders();
    if (!r.ok) {
      const code =
        r.error === 'NOT_CONNECTED'
          ? 409
          : r.status === 401 || r.status === 403
          ? r.status
          : 502;
      return res.status(code).json({
        ok: false,
        error: r.error,
        message: r.message,
        attempted: 0,
        sent: 0,
        failed: 0,
        remaining: 0,
        results: [],
      });
    }

    // Only orders that have NOT been sent successfully yet.
    const pending = r.orders.filter((o) => !o.alreadySent);
    const batch = pending.slice(0, cap);
    const remaining = Math.max(pending.length - batch.length, 0);

    let sent = 0;
    let failed = 0;
    const results = [];

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      try {
        const got = await fetchOrderById(item.id);
        if (!got.ok) {
          failed += 1;
          results.push({
            order_number: item.order_number,
            success: false,
            response: `fetch failed: ${got.error || 'NOT_FOUND'}`,
          });
        } else {
          // No skipIdempotency: processOrder's own idempotency +
          // our alreadySent filter together prevent duplicates.
          const out = await processOrder(got.order, {
            source: 'send-all',
          });
          if (out && out.success) sent += 1;
          else failed += 1;
          results.push({
            order_number:
              (out && out.order_number) || item.order_number,
            success: Boolean(out && out.success),
            response: (out && out.response) || '',
          });
        }
      } catch (err) {
        failed += 1;
        results.push({
          order_number: item.order_number,
          success: false,
          response: `error: ${err.message}`,
        });
      }
      // Pace between sends (Shopify ~2 req/s + WhatsApp pacing).
      if (i < batch.length - 1) await sleep(SEND_ALL_DELAY_MS);
    }

    res.json({
      ok: true,
      attempted: batch.length,
      sent,
      failed,
      remaining,
      results,
    });
  })
);

// ------------------------------------------------------------
//  GET /api/meta/info -> sending number + Meta templates (for UI)
// ------------------------------------------------------------
app.get(
  '/api/meta/info',
  wrap(async (_req, res) => {
    if (!isMetaConfigured()) {
      return res.json({
        ok: true,
        configured: false,
        provider: config.messageProvider,
      });
    }
    const [nums, tpls] = await Promise.all([
      metaGetPhoneNumbers(),
      listTemplatesMeta(),
    ]);
    res.json({
      ok: true,
      configured: true,
      provider: config.messageProvider,
      apiVersion: config.meta.apiVersion,
      phoneNumberId: config.meta.phoneNumberId,
      numbers: nums.ok ? nums.numbers : [],
      numbersError: nums.ok ? null : nums.error,
      templates: tpls.ok
        ? tpls.templates.map((t) => ({
            name: t.name,
            language: t.language,
            status: t.status,
            bodyParamCount: t.bodyParamCount,
          }))
        : [],
      templatesError: tpls.ok ? null : tpls.error,
    });
  })
);

// ------------------------------------------------------------
//  POST /api/shopify/test-last-order
//  Sends the REAL latest order's data through the full pipeline
//  (saved mapping + joud.chat) but to a phone number you choose,
//  so you can confirm the WhatsApp message actually arrives.
//  Body: { phone_number }  (required)
// ------------------------------------------------------------
app.post(
  '/api/shopify/test-last-order',
  wrap(async (req, res) => {
    const phone = String((req.body && req.body.phone_number) || '').trim();
    if (!phone) {
      return res
        .status(400)
        .json({ ok: false, error: 'phone_number is required.' });
    }

    const result = await fetchLatestOrder();
    if (!result.ok) {
      const code =
        result.error === 'NOT_CONNECTED'
          ? 409
          : result.status === 401 || result.status === 403
          ? result.status
          : 502;
      return res.status(code).json({
        ok: false,
        error: result.error || 'FETCH_FAILED',
        message: result.message || 'Could not fetch the latest order.',
      });
    }

    const out = await processOrder(result.order, {
      source: 'test-last-order',
      phoneOverride: phone,
      skipIdempotency: true,
    });
    res.json({ ok: true, result: out });
  })
);

// ------------------------------------------------------------
//  Shared pipeline: resolve + send + log for a given order.
// ------------------------------------------------------------
async function processOrder(
  order,
  { source, phoneOverride = '', skipIdempotency = false } = {}
) {
  const cfg = await getConfig();
  const settings = cfg.settings || {};
  const mapping = cfg.mapping || {};
  const phoneNumberId = cfg.phone_number_id || config.joud.phoneNumberId;
  // We send via Meta using the configured template (order_confirm_iamge:
  // IMAGE header + 11 body params). Template name is the identity used
  // for logging/idempotency.
  const templateName = config.meta.templateName;
  const templateId = templateName;

  // Canonical body-variable order for the order_confirm* templates
  // (POSITIONAL). order_confirm_iamge has 11 (no product photo — that
  // is the IMAGE header). The legacy 12-var template adds orderPhoto.
  const CANON_BODY_VARS = [
    'storeName',
    'customerName',
    'orderId',
    'orderNumber',
    'orderDescription',
    'orderCost',
    'orderStatus',
    'customerAddress',
    'otherAddress',
    'customerCity',
    'customerGovernorate',
  ];

  // For test sends the caller can force the recipient (e.g. send a
  // real order's data to the tester's own WhatsApp number instead of
  // the customer's). Otherwise resolve it from the order/settings.
  const resolveRecipient = () => {
    if (phoneOverride && String(phoneOverride).trim()) {
      return normalizePhone(
        phoneOverride,
        (settings && settings.default_country_code) ||
          config.defaults.defaultCountryCode
      );
    }
    return pickRecipientPhone(order, settings);
  };

  if (!templateId) {
    const rec = {
      shopify_order_id: order.id,
      order_number: order.name || order.order_number,
      recipient_phone: resolveRecipient(),
      template_id: null,
      variables: {},
      success: false,
      response: 'No template selected/saved in config. Open the UI and save a template + mapping.',
    };
    await insertLog(rec);
    return { ...rec, skipped: true };
  }

  // Idempotency (best effort): skip if already sent successfully.
  // Test sends bypass this so the user can re-test freely.
  const already = skipIdempotency
    ? false
    : await hasSuccessfulLog(order.id, templateId);
  if (already) {
    return {
      shopify_order_id: order.id,
      order_number: order.name || order.order_number,
      template_id: templateId,
      success: true,
      skipped: true,
      response: 'Skipped: already sent successfully for this order+template.',
    };
  }

  // Enrich from Shopify: real product image URL (-> IMAGE header) +
  // size/color in the description (المقاس/اللون). Best-effort.
  try {
    await enrichOrderFromShopify(order);
  } catch {
    /* non-fatal: image / description just fall back */
  }

  const { values } = resolveVariablesForOrder(order, mapping, settings);
  const phoneNumber = resolveRecipient();

  if (!phoneNumber) {
    const rec = {
      shopify_order_id: order.id,
      order_number: order.name || order.order_number,
      recipient_phone: '',
      template_id: templateId,
      variables: values,
      success: false,
      response: 'No recipient phone number could be resolved from the order.',
    };
    await insertLog(rec);
    return rec;
  }

  // Build the 11 body params in canonical placeholder order. Prefer
  // the saved mapping's resolved value; fall back to the resolver
  // directly so a missing mapping entry never blanks a field.
  const orderedValues = CANON_BODY_VARS.map((name) => {
    if (values[name] != null && values[name] !== '') return String(values[name]);
    const r = resolvers[name];
    if (r && typeof r.fn === 'function') {
      try {
        const v = r.fn(order, settings);
        return v == null ? '' : String(v);
      } catch {
        return '';
      }
    }
    return '';
  });

  // IMAGE header = the real product photo (enriched from Shopify).
  const headerImageUrl =
    order.productImageUrl || config.meta.fallbackImage || '';

  let sendResult;
  try {
    const m = await metaSendTemplate({
      to: phoneNumber,
      templateName,
      languageCode: config.meta.templateLang,
      orderedValues,
      headerImageUrl,
    });
    sendResult = {
      success: m.success,
      httpStatus: m.httpStatus,
      raw: m.messageId ? `msg ${m.messageId} :: ${m.raw}` : m.raw,
    };
  } catch (err) {
    sendResult = { success: false, raw: `send error: ${err.message}`, httpStatus: 0 };
  }

  const rec = {
    shopify_order_id: order.id,
    order_number: order.name || order.order_number,
    recipient_phone: phoneNumber,
    template_id: templateId,
    variables: { ...values, __headerImage: headerImageUrl },
    success: sendResult.success,
    response: `[${source}] HTTP ${sendResult.httpStatus} :: ${sendResult.raw}`,
  };
  await insertLog(rec);
  return rec;
}

// ------------------------------------------------------------
//  POST /api/test-send
//  body: { phone_number, template_id?, phone_number_id? }
// ------------------------------------------------------------
app.post(
  '/api/test-send',
  wrap(async (req, res) => {
    const body = req.body || {};
    const phone = String(body.phone_number || '').trim();
    if (!phone) {
      return res
        .status(400)
        .json({ ok: false, error: 'phone_number is required for a test send.' });
    }

    // If the caller passes a template/pnid, persist it first so the
    // shared pipeline (which reads config) uses it.
    const partial = {};
    if (body.template_id) partial.selected_template_id = String(body.template_id);
    if (body.phone_number_id) partial.phone_number_id = String(body.phone_number_id);
    if (Object.keys(partial).length) await saveConfig(partial);

    // Build a sample order whose customer phone is the tester's number.
    const order = buildSampleOrder({
      id: `TEST-${Date.now()}`,
      name: `#TEST`,
      order_number: 'TEST',
      phone,
      customer: {
        first_name: 'Test',
        last_name: 'Customer',
        phone,
        email: 'test@example.com',
      },
    });
    // Make shipping/billing phone match too.
    order.shipping_address.phone = phone;
    order.billing_address.phone = phone;

    const result = await processOrder(order, { source: 'test-send' });
    res.json({ ok: true, result });
  })
);

// ------------------------------------------------------------
//  POST /webhooks/shopify/orders-create
//  raw body parser already applied to this path.
// ------------------------------------------------------------
app.post(
  '/webhooks/shopify/orders-create',
  wrap(async (req, res) => {
    const rawBody = req.body; // Buffer (express.raw)
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

    // 1. Verify HMAC against the RAW bytes.
    const valid = verifyWebhookHmac(rawBody, hmacHeader, config.shopify.apiSecret);
    if (!valid) {
      console.warn('[webhook] HMAC verification FAILED.');
      return res.status(401).json({ ok: false, error: 'HMAC verification failed' });
    }

    // 2. Parse the order JSON defensively.
    let order;
    try {
      order = JSON.parse(
        Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '{}')
      );
    } catch {
      // Bad JSON: ack with 200 so Shopify doesn't retry forever, but log it.
      console.warn('[webhook] received invalid JSON body.');
      await insertLog({
        shopify_order_id: null,
        order_number: null,
        recipient_phone: null,
        template_id: null,
        variables: {},
        success: false,
        response: 'Webhook received but body was not valid JSON.',
      });
      return res.status(200).json({ ok: true, note: 'invalid json acknowledged' });
    }

    // 3. Run the shared pipeline. Always answer 200 (Shopify needs a
    //    fast 2xx) — the outcome is captured in the message log.
    try {
      const result = await processOrder(order, { source: 'shopify-webhook' });
      return res.status(200).json({ ok: true, result });
    } catch (err) {
      console.error('[webhook] pipeline error:', err.message);
      await insertLog({
        shopify_order_id: order && order.id,
        order_number: order && (order.name || order.order_number),
        recipient_phone: null,
        template_id: null,
        variables: {},
        success: false,
        response: `Pipeline error: ${err.message}`,
      });
      return res.status(200).json({ ok: true, note: 'error logged' });
    }
  })
);

// ------------------------------------------------------------
//  WhatsApp (Meta) status webhook
//
//  Meta returns message_status:"accepted" on the send call, which
//  only means "queued for delivery" — NOT delivered. The real
//  delivery outcome (sent / delivered / read / FAILED with an error
//  code) arrives later as a `statuses[]` callback. Without this
//  receiver the app can never observe a delivery failure (e.g. the
//  WABA being inactive), so an "accepted" message that is silently
//  dropped looks like a success forever.
//
//  Point the app's webhook (Meta App > WhatsApp > Configuration) at
//  POST /webhooks/whatsapp and subscribe to the `messages` field.
//  Set META_WEBHOOK_VERIFY_TOKEN to any string and use it as the
//  "Verify token" in the Meta dashboard.
// ------------------------------------------------------------
app.get(
  '/webhooks/whatsapp',
  wrap(async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expected = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
    if (mode === 'subscribe' && expected && token === expected) {
      return res.status(200).send(String(challenge ?? ''));
    }
    return res.status(403).json({ ok: false, error: 'verify token mismatch' });
  })
);

app.post(
  '/webhooks/whatsapp',
  wrap(async (req, res) => {
    // Always 200 fast so Meta does not disable the webhook.
    res.status(200).json({ ok: true });

    // Reject forged payloads: an unverified caller must not be able
    // to drive Shopify writes / outbound WhatsApp via fake button taps.
    if (!verifyMetaSignature(req)) {
      console.warn(
        '[webhooks/whatsapp] X-Hub-Signature-256 invalid — payload ignored.'
      );
      return;
    }

    try {
      const body = req.body || {};
      const entries = Array.isArray(body.entry) ? body.entry : [];
      for (const entry of entries) {
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        for (const change of changes) {
          const value = (change && change.value) || {};
          const statuses = Array.isArray(value.statuses) ? value.statuses : [];
          for (const st of statuses) {
            const status = st && st.status; // sent|delivered|read|failed
            const msgId = st && st.id;
            const recipient = st && st.recipient_id;
            const errs = Array.isArray(st && st.errors) ? st.errors : [];
            const errText = errs
              .map(
                (e) =>
                  `${e.code || '?'} ${e.title || ''}` +
                  (e.error_data && e.error_data.details
                    ? ` (${e.error_data.details})`
                    : '')
              )
              .join('; ');

            const line =
              `[whatsapp-status] msg ${msgId || '?'} -> ${status || '?'}` +
              (recipient ? ` to ${recipient}` : '') +
              (errText ? ` :: ${errText}` : '');
            if (status === 'failed') console.error(line);
            else console.log(line);

            // Record FAILED deliveries so the operator can see the
            // real error code instead of a misleading "success".
            if (status === 'failed') {
              await insertLog({
                shopify_order_id: null,
                order_number: null,
                recipient_phone: recipient || null,
                template_id: null,
                variables: {},
                success: false,
                response:
                  `[whatsapp-status] DELIVERY FAILED for msg ${msgId || '?'}` +
                  (errText ? ` :: ${errText}` : ' :: (no error detail)'),
              });
            }
          }

          // Inbound messages — react to template quick-reply taps.
          const messages = Array.isArray(value.messages)
            ? value.messages
            : [];
          for (const m of messages) {
            await processInboundWhatsAppMessage(m).catch((e) =>
              console.error('[whatsapp-inbound] error:', e.message)
            );
          }
        }
      }
    } catch (err) {
      console.error('[webhooks/whatsapp] handler error:', err.message);
    }
  })
);

// ------------------------------------------------------------
//  processInboundWhatsAppMessage(msg)
//
//  Handles a customer tapping a template quick-reply button. The
//  tap is itself an inbound message, which opens a 24h session, so
//  we can send free-form image/text replies here.
//   - "أحتاج الي استفسار"  -> send images + details of ALL products
//   - "تأكيد الأوردر"      -> confirm the order in Shopify (tag it)
//   - "الغاء الأوردر"      -> acknowledge (no Shopify change)
// ------------------------------------------------------------
async function processInboundWhatsAppMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const from = String(msg.from || '').replace(/\D/g, '');
  if (!from) return;

  // Button label from a template quick-reply OR an interactive reply.
  let label = '';
  if (msg.type === 'button' && msg.button) {
    label = msg.button.text || msg.button.payload || '';
  } else if (
    msg.type === 'interactive' &&
    msg.interactive &&
    msg.interactive.button_reply
  ) {
    label = msg.interactive.button_reply.title || msg.interactive.button_reply.id || '';
  }
  label = String(label || '').trim();
  if (!label) return; // plain text/other inbound — ignore for now

  const orderId = await findRecentOrderByPhone(from);
  console.log(
    `[whatsapp-inbound] from ${from} tapped "${label}" (order ${orderId || '?'})`
  );

  // ---- Confirm order ----
  if (/تأكيد|تاكيد|confirm/i.test(label)) {
    if (!orderId) {
      await metaSendText({
        to: from,
        text: 'لم نتمكن من ربط رقمك بطلب حديث. تواصل معنا من فضلك 🙏',
      });
      return;
    }
    const r = await confirmShopifyOrder(orderId);
    const ok = r && r.ok;
    await metaSendText({
      to: from,
      text: ok
        ? 'تم تأكيد طلبك بنجاح ✅ جارٍ التجهيز والشحن 📦'
        : 'حصلت مشكلة أثناء تأكيد الطلب، فريقنا هيتواصل معك 🙏',
    });
    await insertLog({
      shopify_order_id: orderId,
      order_number: null,
      recipient_phone: from,
      template_id: null,
      variables: { action: 'confirm', button: label },
      success: Boolean(ok),
      response: `[inbound] confirm -> ${
        ok ? (r.alreadyConfirmed ? 'already confirmed' : 'tagged confirmed') : (r && r.message) || 'failed'
      }`,
    });
    return;
  }

  // ---- Need inquiry -> send all products' images + details ----
  if (/استفسار|inquiry|تعديل/i.test(label)) {
    if (!orderId) {
      await metaSendText({
        to: from,
        text: 'لم نتمكن من ربط رقمك بطلب حديث. تواصل معنا من فضلك 🙏',
      });
      return;
    }
    const got = await fetchOrderById(orderId);
    if (!got.ok) {
      await metaSendText({
        to: from,
        text: 'تعذّر جلب تفاصيل الطلب حاليًا، حاول لاحقًا 🙏',
      });
      return;
    }
    const items = await getOrderItemsDetailed(got.order);
    if (!items.length) {
      await metaSendText({ to: from, text: 'لا توجد أصناف في هذا الطلب.' });
      return;
    }
    const MAX_SEND = 10; // cap outbound messages per inquiry
    const toSend = items.slice(0, MAX_SEND);
    await metaSendText({
      to: from,
      text: `تفاصيل منتجات طلبك (${items.length} صنف) 👇`,
    });
    let sent = 0;
    for (let i = 0; i < toSend.length; i++) {
      const it = toSend[i];
      const parts = [`${it.qty}x ${it.title}`];
      if (it.size) parts.push(`المقاس : ${it.size}`);
      if (it.color) parts.push(`اللون : ${it.color}`);
      const caption = `(${i + 1}/${items.length}) ${parts.join(' - ')}`;
      let r;
      if (it.imageUrl) {
        r = await metaSendImage({ to: from, imageUrl: it.imageUrl, caption });
      } else {
        r = await metaSendText({ to: from, text: caption });
      }
      if (r && r.success) sent += 1;
    }
    if (items.length > MAX_SEND) {
      await metaSendText({
        to: from,
        text: `وباقي المنتجات (${items.length - MAX_SEND}) — لو محتاج صورها تواصل معنا 🙏`,
      });
    }
    await insertLog({
      shopify_order_id: orderId,
      order_number: got.order.name || got.order.order_number,
      recipient_phone: from,
      template_id: null,
      variables: { action: 'inquiry', items: items.length, sent },
      success: sent > 0,
      response: `[inbound] inquiry -> sent ${sent}/${items.length} product messages`,
    });
    return;
  }

  // ---- Cancel / other: acknowledge only ----
  if (/الغاء|إلغاء|cancel/i.test(label)) {
    await metaSendText({
      to: from,
      text: 'تم استلام طلب الإلغاء، فريق خدمة العملاء هيتواصل معك للتأكيد 🙏',
    });
    await insertLog({
      shopify_order_id: orderId,
      order_number: null,
      recipient_phone: from,
      template_id: null,
      variables: { action: 'cancel', button: label },
      success: true,
      response: '[inbound] cancel acknowledged (no Shopify change)',
    });
  }
}

// SPA fallback -> index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global safety nets so the process never dies on an unhandled error.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const server = app.listen(config.port, () => {
  console.log(`\n  Shopify <-> joud.chat WhatsApp bridge`);
  console.log(`  Listening on http://localhost:${config.port}`);
  console.log(`  Supabase: ${isSupabaseEnabled() ? 'connected' : 'DEGRADED (in-memory)'}`);
  console.log(`  Webhook:  POST /webhooks/shopify/orders-create\n`);
});

export default server;
