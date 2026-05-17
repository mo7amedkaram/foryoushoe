// ============================================================
//  src/shopifyOAuth.js
//  Shopify OAuth (authorization code grant) — OFFLINE token flow.
//
//  This is SEPARATE from the webhook HMAC (src/shopify.js):
//   - Webhook HMAC: base64( HMAC-SHA256( raw body ) )           [unchanged]
//   - OAuth callback HMAC: hex( HMAC-SHA256( sorted query ) )   [here]
//
//  Reference: https://shopify.dev/docs/apps/auth/oauth
//  Node 22 global fetch; every network call has a hard ~10s timeout
//  and is defensive (never throws raw to the caller).
// ============================================================
import crypto from 'node:crypto';
import { config } from './config.js';
import { getShopifyAuth, saveShopifyAuth } from './supabase.js';

const TIMEOUT_MS = 10000;
const ADMIN_API_VERSION = '2025-01';
const OAUTH_SCOPES = 'read_orders,read_products';

// shop must look exactly like "<store>.myshopify.com"
const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export { OAUTH_SCOPES, ADMIN_API_VERSION };

// ------------------------------------------------------------
//  isValidShop(shop)
// ------------------------------------------------------------
export function isValidShop(shop) {
  return typeof shop === 'string' && SHOP_RE.test(shop.trim());
}

// fetch with a hard timeout so a hanging Shopify call can never
// block the server beyond ~10s.
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

// ------------------------------------------------------------
//  buildInstallUrl({ shop, redirectUri, state })
//
//  Offline (non-expiring) token => DO NOT include grant_options[].
//  Returns the full https://{shop}/admin/oauth/authorize?... URL.
// ------------------------------------------------------------
export function buildInstallUrl({ shop, redirectUri, state }) {
  const cleanShop = String(shop || '').trim();
  if (!isValidShop(cleanShop)) {
    throw new Error(`Invalid shop domain: "${cleanShop}"`);
  }
  const params = new URLSearchParams({
    client_id: config.shopify.apiKey,
    scope: OAUTH_SCOPES,
    redirect_uri: redirectUri,
    state: String(state || ''),
  });
  return `https://${cleanShop}/admin/oauth/authorize?${params.toString()}`;
}

// ------------------------------------------------------------
//  verifyOAuthHmac(query, secret)
//
//  Shopify's documented algorithm for OAuth / redirect requests:
//   1. Remove `hmac` (and `signature`, if present) from the params.
//   2. Sort the remaining params by key (lexicographic).
//   3. Join as `key=value` pairs with `&` using the *decoded* values
//      (Express already percent-decodes req.query).
//   4. HMAC-SHA256 with the app SECRET, HEX digest.
//   5. Timing-safe compare against the `hmac` query param.
//
//  This is HEX (different from the base64 webhook body HMAC).
//  `query` is expected to be the raw req.query object.
// ------------------------------------------------------------
export function verifyOAuthHmac(query, secret) {
  if (!query || typeof query !== 'object') return false;
  const provided = query.hmac;
  if (!provided || !secret) return false;

  // Build the message from every param except hmac/signature.
  const pairs = [];
  for (const key of Object.keys(query)) {
    if (key === 'hmac' || key === 'signature') continue;
    const raw = query[key];
    // Express may give arrays for repeated params — join them the
    // way Shopify expects (comma-joined).
    const value = Array.isArray(raw) ? raw.join(',') : String(raw);
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const message = pairs.join('&');

  const digest = crypto
    .createHmac('sha256', secret)
    .update(message, 'utf8')
    .digest('hex');

  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
//  exchangeCodeForToken({ shop, code })
//
//  POST https://{shop}/admin/oauth/access_token
//  body: client_id, client_secret, code
//  Offline response: { access_token, scope }  (does NOT expire)
//
//  Returns { ok, access_token, scope } or { ok:false, error }.
//  Never throws.
// ------------------------------------------------------------
export async function exchangeCodeForToken({ shop, code }) {
  const cleanShop = String(shop || '').trim();
  if (!isValidShop(cleanShop)) {
    return { ok: false, error: `Invalid shop domain: "${cleanShop}"` };
  }
  if (!code) return { ok: false, error: 'Missing authorization code.' };

  const url = `https://${cleanShop}/admin/oauth/access_token`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: config.shopify.apiKey,
        client_secret: config.shopify.apiSecret,
        code: String(code),
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Token exchange request failed: ${err.message}`,
    };
  }

  const text = await res.text().catch(() => '');
  const json = safeJsonParse(text, null);

  if (!res.ok || !json || !json.access_token) {
    return {
      ok: false,
      error: `Token exchange HTTP ${res.status}: ${String(text).slice(0, 300)}`,
    };
  }

  return {
    ok: true,
    access_token: json.access_token,
    scope: json.scope || OAUTH_SCOPES,
  };
}

// ------------------------------------------------------------
//  getClientCredentialsToken({ shop, clientId, clientSecret })
//
//  Shopify CLIENT CREDENTIALS grant — fully headless. No browser,
//  no redirect URI, no merchant authorization. This is the path the
//  joud.chat "Generate Access Token" feature uses.
//
//  POST https://{shop}/admin/oauth/access_token
//    Content-Type: application/x-www-form-urlencoded
//    grant_type=client_credentials & client_id & client_secret
//  Response: { access_token: "shpat_...", scope, expires_in: 86399 }
//  The token lives ~24h; refresh by repeating the exact same request.
//
//  Only works for an app developed by your own org and installed in
//  a store you own (exactly this project's setup). Never throws.
// ------------------------------------------------------------
export async function getClientCredentialsToken({
  shop,
  clientId,
  clientSecret,
} = {}) {
  const cleanShop = String(shop || config.shopify.shopDomain || '').trim();
  if (!isValidShop(cleanShop)) {
    return { ok: false, error: `Invalid shop domain: "${cleanShop}"` };
  }
  const cid = String(clientId || config.shopify.apiKey || '').trim();
  const csec = String(clientSecret || config.shopify.apiSecret || '').trim();
  if (!cid || !csec) {
    return { ok: false, error: 'Missing client_id / client_secret.' };
  }

  const url = `https://${cleanShop}/admin/oauth/access_token`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cid,
        client_secret: csec,
      }).toString(),
    });
  } catch (err) {
    return { ok: false, error: `Token request failed: ${err.message}` };
  }

  const text = await res.text().catch(() => '');
  const json = safeJsonParse(text, null);

  if (!res.ok || !json || !json.access_token) {
    return {
      ok: false,
      status: res.status,
      error: `Client-credentials HTTP ${res.status}: ${String(text).slice(0, 300)}`,
    };
  }

  const expiresIn = Number(json.expires_in) || 86399;
  return {
    ok: true,
    shop: cleanShop,
    access_token: json.access_token,
    scope: json.scope || '',
    expires_in: expiresIn,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

// ------------------------------------------------------------
//  getAdminToken() -> { shop, access_token, scope, obtained_at }|null
//  Reads the stored token from Supabase (or memory fallback).
// ------------------------------------------------------------
export async function getAdminToken() {
  try {
    const auth = await getShopifyAuth();
    if (auth && auth.access_token) return auth;
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
//  ensureAdminToken() -> auth | null
//
//  Returns a usable token. Because client-credentials tokens expire
//  in ~24h, we transparently (re)generate one via client credentials
//  when the stored token is missing or within 5 minutes of expiry.
//  Falls back to a possibly-stale stored token rather than nothing.
// ------------------------------------------------------------
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export async function ensureAdminToken() {
  // Highest priority: a static Admin API token from .env (e.g. a
  // store custom app shpat_ token with read_products). No expiry,
  // no client-credentials needed.
  if (config.shopify.adminToken) {
    return {
      shop: config.shopify.shopDomain,
      access_token: config.shopify.adminToken,
      scope: 'static',
      expires_at: null,
    };
  }

  let auth = null;
  try {
    auth = await getShopifyAuth();
  } catch {
    auth = null;
  }

  const expMs = auth && auth.expires_at ? Date.parse(auth.expires_at) : NaN;
  const stillValid =
    auth &&
    auth.access_token &&
    (!Number.isFinite(expMs) || expMs - Date.now() > EXPIRY_SKEW_MS);
  if (stillValid) return auth;

  const fresh = await getClientCredentialsToken({
    shop: (auth && auth.shop) || config.shopify.shopDomain,
  });
  if (!fresh.ok) {
    // Could not refresh — better to try a stale token than fail hard.
    return auth && auth.access_token ? auth : null;
  }

  try {
    await saveShopifyAuth({
      shop: fresh.shop,
      access_token: fresh.access_token,
      scope: fresh.scope,
      expires_at: fresh.expires_at,
    });
  } catch {
    /* memory fallback inside saveShopifyAuth already handled it */
  }
  return {
    shop: fresh.shop,
    access_token: fresh.access_token,
    scope: fresh.scope,
    expires_at: fresh.expires_at,
  };
}

// ------------------------------------------------------------
//  adminApiGet(path) -> { ok, status, data } | { ok:false, error }
//
//  path e.g. "orders.json?status=any&limit=1"
//  Uses the stored offline token. Never throws.
// ------------------------------------------------------------
export async function adminApiGet(path, { _retried = false } = {}) {
  const auth = await ensureAdminToken();
  if (!auth || !auth.access_token) {
    return {
      ok: false,
      status: 0,
      error: 'NOT_CONNECTED',
      message:
        'Could not obtain a Shopify access token. Generate one from the ' +
        'dashboard (Store sub-domain + Client ID + Client Secret), or check ' +
        'that the app is installed on the store.',
    };
  }
  const shop = auth.shop || config.shopify.shopDomain;
  if (!isValidShop(shop)) {
    return {
      ok: false,
      status: 0,
      error: 'INVALID_SHOP',
      message: `Stored shop domain is invalid: "${shop}".`,
    };
  }

  const cleanPath = String(path).replace(/^\/+/, '');
  const url = `https://${shop}/admin/api/${ADMIN_API_VERSION}/${cleanPath}`;

  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': auth.access_token,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: 'REQUEST_FAILED',
      message: `Shopify Admin API request failed: ${err.message}`,
    };
  }

  const text = await res.text().catch(() => '');
  const json = safeJsonParse(text, null);

  if (res.status === 401 && !_retried) {
    // Token likely expired/revoked — force a brand-new client-
    // credentials token once, then retry the same request.
    const fresh = await getClientCredentialsToken({ shop });
    if (fresh.ok) {
      await saveShopifyAuth({
        shop: fresh.shop,
        access_token: fresh.access_token,
        scope: fresh.scope,
        expires_at: fresh.expires_at,
      });
      return adminApiGet(path, { _retried: true });
    }
  }
  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      error: 'UNAUTHORIZED',
      message:
        'Shopify rejected the access token (401) and refreshing it failed. ' +
        'Check the Client ID / Client Secret and that the app is installed ' +
        'on the store, then generate the token again.',
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      status: 403,
      error: 'FORBIDDEN_PROTECTED_DATA',
      message:
        'Shopify returned 403 for the Orders API. The Orders/customer fields ' +
        'are PROTECTED customer data. In the Shopify Partner/Developer ' +
        'dashboard open the app → "API access" → "Protected customer data ' +
        'access" and request/enable access (Orders + customer PII), then ' +
        're-connect via /auth.',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: 'HTTP_ERROR',
      message: `Shopify Admin API HTTP ${res.status}: ${String(text).slice(0, 300)}`,
    };
  }
  if (!json) {
    return {
      ok: false,
      status: res.status,
      error: 'BAD_JSON',
      message: `Shopify Admin API returned non-JSON: ${String(text).slice(0, 300)}`,
    };
  }

  return { ok: true, status: res.status, data: json };
}

// ------------------------------------------------------------
//  fetchLatestOrder() -> { ok, order } | { ok:false, error, ... }
//
//  Newest order first. We explicitly request created_at desc and
//  also sort client-side as a belt-and-braces safeguard.
// ------------------------------------------------------------
export async function fetchLatestOrder() {
  const result = await adminApiGet(
    'orders.json?status=any&limit=1&order=created_at+desc'
  );
  if (!result.ok) return result;

  const orders = Array.isArray(result.data && result.data.orders)
    ? result.data.orders
    : [];

  if (orders.length === 0) {
    return {
      ok: false,
      status: 200,
      error: 'NO_ORDERS',
      message:
        'The store is connected but has no orders yet. Place a test order ' +
        'in Shopify, then try again.',
    };
  }

  // Client-side safeguard: pick the most recent by created_at.
  orders.sort((a, b) => {
    const ta = Date.parse(a && a.created_at) || 0;
    const tb = Date.parse(b && b.created_at) || 0;
    return tb - ta;
  });

  return { ok: true, order: orders[0] };
}

// ------------------------------------------------------------
//  fetchProductImageUrl(order) -> "https://...jpg" | ''
//
//  Shopify's order webhook line_items DON'T carry the product
//  image. We resolve it from the Admin API: prefer the ordered
//  variant's own image, then the product's featured image, then
//  the first product image. Never throws — returns '' on any miss.
// ------------------------------------------------------------
export async function fetchProductImageUrl(order) {
  try {
    const items = Array.isArray(order && order.line_items)
      ? order.line_items
      : [];
    const li = items.find((x) => x && x.product_id) || null;
    if (!li) return '';

    const productId = String(li.product_id);
    const variantId = li.variant_id ? String(li.variant_id) : '';

    const res = await adminApiGet(
      `products/${productId}.json?fields=id,image,images,variants`
    );
    if (!res.ok || !res.data || !res.data.product) return '';
    const p = res.data.product;
    const images = Array.isArray(p.images) ? p.images : [];

    // 1. The exact variant's image, if the variant has one.
    if (variantId && Array.isArray(p.variants)) {
      const v = p.variants.find((x) => String(x.id) === variantId);
      if (v && v.image_id) {
        const vi = images.find((im) => String(im.id) === String(v.image_id));
        if (vi && vi.src) return String(vi.src);
      }
    }
    // 2. Product featured image.
    if (p.image && p.image.src) return String(p.image.src);
    // 3. First image as a last resort.
    if (images[0] && images[0].src) return String(images[0].src);
    return '';
  } catch {
    return '';
  }
}

// ------------------------------------------------------------
//  enrichOrderFromShopify(order)
//
//  The Shopify order payload has the variant TITLE ("Nude / 41")
//  but not labelled options. Fetch each product once to map the
//  ordered variant's options to their names, then attach to the
//  order:
//    order.productImageUrl    -> real image URL (variant > product)
//    order.formattedDescription -> "1x <title> - المقاس : 41 - اللون : Nude"
//  WhatsApp forbids newlines in params, so this is ONE line per
//  item (items joined with " | "). Never throws — best effort.
// ------------------------------------------------------------
export async function enrichOrderFromShopify(order) {
  try {
    const items = Array.isArray(order && order.line_items)
      ? order.line_items
      : [];
    if (!items.length) return;

    const norm = (s) => String(s == null ? '' : s).trim();
    const cache = new Map();
    const getProduct = async (pid) => {
      if (!pid) return null;
      if (cache.has(pid)) return cache.get(pid);
      const res = await adminApiGet(
        `products/${pid}.json?fields=id,image,images,options,variants`
      );
      const p = res && res.ok && res.data ? res.data.product : null;
      cache.set(pid, p || null);
      return p;
    };

    let imageSet = Boolean(order.productImageUrl);
    const lines = [];

    // Cap to avoid hundreds of sequential Admin API calls on a
    // pathological order (Shopify rate-limits ~2 req/s).
    for (const li of items.slice(0, 25)) {
      const qty = li.quantity || 1;
      const title = norm(li.title || li.name) || 'item';
      const p = await getProduct(li.product_id ? String(li.product_id) : '');

      let size = '';
      let color = '';
      if (p) {
        const opts = Array.isArray(p.options) ? p.options : [];
        const variants = Array.isArray(p.variants) ? p.variants : [];
        const v = variants.find(
          (x) => String(x.id) === String(li.variant_id)
        );
        const optVal = (pos) => (v ? v[`option${pos}`] : null);
        for (const o of opts) {
          const val = norm(optVal(o.position));
          if (!val) continue;
          if (/colou?r|لون/i.test(o.name)) color = val;
          else if (/size|مقاس/i.test(o.name)) size = val;
        }

        if (!imageSet) {
          const images = Array.isArray(p.images) ? p.images : [];
          let src = '';
          if (v && v.image_id) {
            const vi = images.find(
              (im) => String(im.id) === String(v.image_id)
            );
            if (vi && vi.src) src = vi.src;
          }
          if (!src && p.image && p.image.src) src = p.image.src;
          if (!src && images[0] && images[0].src) src = images[0].src;
          if (src) {
            order.productImageUrl = String(src);
            imageSet = true;
          }
        }
      }

      let s = `${qty}x ${title}`;
      if (size) s += ` - المقاس : ${size}`;
      if (color) s += ` - اللون : ${color}`;
      // Last resort if options couldn't be classified.
      if (!size && !color && norm(li.variant_title)) {
        s += ` - ${norm(li.variant_title)}`;
      }
      lines.push(s);
    }

    if (lines.length) order.formattedDescription = lines.join(' | ');
  } catch {
    /* best effort — leave order unchanged on any failure */
  }
}

// ------------------------------------------------------------
//  adminApiSend(method, path, body) — write helper (PUT/POST).
//  Mirrors adminApiGet's auth + one 401 refresh-retry.
// ------------------------------------------------------------
export async function adminApiSend(method, path, body, { _retried = false } = {}) {
  const auth = await ensureAdminToken();
  if (!auth || !auth.access_token) {
    return { ok: false, status: 0, error: 'NOT_CONNECTED' };
  }
  const shop = auth.shop || config.shopify.shopDomain;
  if (!isValidShop(shop)) {
    return { ok: false, status: 0, error: 'INVALID_SHOP' };
  }
  const cleanPath = String(path).replace(/^\/+/, '');
  const url = `https://${shop}/admin/api/${ADMIN_API_VERSION}/${cleanPath}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: String(method || 'POST').toUpperCase(),
      headers: {
        'X-Shopify-Access-Token': auth.access_token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, error: 'REQUEST_FAILED', message: err.message };
  }
  const text = await res.text().catch(() => '');
  const json = safeJsonParse(text, null);
  if (res.status === 401 && !_retried) {
    const fresh = await getClientCredentialsToken({ shop });
    if (fresh.ok) {
      await saveShopifyAuth({
        shop: fresh.shop,
        access_token: fresh.access_token,
        scope: fresh.scope,
        expires_at: fresh.expires_at,
      });
      return adminApiSend(method, path, body, { _retried: true });
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: 'HTTP_ERROR',
      message: `Shopify Admin API HTTP ${res.status}: ${String(text).slice(0, 300)}`,
    };
  }
  return { ok: true, status: res.status, data: json };
}

// ------------------------------------------------------------
//  fetchOrderById(orderId) -> { ok, order }
// ------------------------------------------------------------
export async function fetchOrderById(orderId) {
  const res = await adminApiGet(`orders/${encodeURIComponent(orderId)}.json`);
  if (!res.ok || !res.data || !res.data.order) {
    return { ok: false, error: res.error || 'NOT_FOUND', message: res.message };
  }
  return { ok: true, order: res.data.order };
}

// ------------------------------------------------------------
//  confirmShopifyOrder(orderId) — marks the order confirmed by
//  adding a tag (and a note). Requires write_orders (granted).
// ------------------------------------------------------------
export const CONFIRM_TAG = 'WhatsApp Confirmed';

export async function confirmShopifyOrder(orderId) {
  const got = await fetchOrderById(orderId);
  if (!got.ok) return { ok: false, error: got.error, message: got.message };
  const o = got.order;
  const existing = String(o.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (existing.some((t) => t.toLowerCase() === CONFIRM_TAG.toLowerCase())) {
    return { ok: true, alreadyConfirmed: true, order: o };
  }
  existing.push(CONFIRM_TAG);
  const res = await adminApiSend('PUT', `orders/${o.id}.json`, {
    order: { id: o.id, tags: existing.join(', ') },
  });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  return { ok: true, order: res.data && res.data.order };
}

// ------------------------------------------------------------
//  getOrderItemsDetailed(order) -> [{ qty, title, size, color,
//  imageUrl }]  (one entry per line item, with the variant image)
// ------------------------------------------------------------
export async function getOrderItemsDetailed(order) {
  const items = Array.isArray(order && order.line_items)
    ? order.line_items
    : [];
  const norm = (s) => String(s == null ? '' : s).trim();
  const cache = new Map();
  const getProduct = async (pid) => {
    if (!pid) return null;
    if (cache.has(pid)) return cache.get(pid);
    const res = await adminApiGet(
      `products/${pid}.json?fields=id,image,images,options,variants`
    );
    const p = res && res.ok && res.data ? res.data.product : null;
    cache.set(pid, p || null);
    return p;
  };
  const out = [];
  // Cap to bound Admin API calls / outbound messages on huge orders.
  for (const li of items.slice(0, 25)) {
    const qty = li.quantity || 1;
    const title = norm(li.title || li.name) || 'item';
    let size = '';
    let color = '';
    let imageUrl = '';
    const p = await getProduct(li.product_id ? String(li.product_id) : '');
    if (p) {
      const opts = Array.isArray(p.options) ? p.options : [];
      const variants = Array.isArray(p.variants) ? p.variants : [];
      const v = variants.find((x) => String(x.id) === String(li.variant_id));
      const optVal = (pos) => (v ? v[`option${pos}`] : null);
      for (const o of opts) {
        const val = norm(optVal(o.position));
        if (!val) continue;
        if (/colou?r|لون/i.test(o.name)) color = val;
        else if (/size|مقاس/i.test(o.name)) size = val;
      }
      const images = Array.isArray(p.images) ? p.images : [];
      if (v && v.image_id) {
        const vi = images.find((im) => String(im.id) === String(v.image_id));
        if (vi && vi.src) imageUrl = vi.src;
      }
      if (!imageUrl && p.image && p.image.src) imageUrl = p.image.src;
      if (!imageUrl && images[0] && images[0].src) imageUrl = images[0].src;
    }
    if (!size && !color && norm(li.variant_title)) {
      // last resort label-less
      size = norm(li.variant_title);
    }
    out.push({ qty, title, size, color, imageUrl });
  }
  return out;
}

export default {
  isValidShop,
  buildInstallUrl,
  verifyOAuthHmac,
  exchangeCodeForToken,
  getClientCredentialsToken,
  getAdminToken,
  ensureAdminToken,
  adminApiGet,
  adminApiSend,
  fetchLatestOrder,
  fetchOrderById,
  confirmShopifyOrder,
  getOrderItemsDetailed,
  fetchProductImageUrl,
  enrichOrderFromShopify,
  CONFIRM_TAG,
  OAUTH_SCOPES,
  ADMIN_API_VERSION,
};
