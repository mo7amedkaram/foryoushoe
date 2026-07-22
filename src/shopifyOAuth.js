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
//
//  Concurrent callers share a single in-flight refresh (single-flight)
//  so a burst of webhooks cannot stampede the token endpoint.
// ------------------------------------------------------------
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
let refreshInFlight = null;

async function refreshClientCredentialsToken(preferredShop) {
  const fresh = await getClientCredentialsToken({
    shop: preferredShop || config.shopify.shopDomain,
  });
  if (!fresh.ok) {
    console.warn(
      `[shopify] client-credentials refresh failed: ${fresh.error || 'unknown'}`
    );
    return null;
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
  console.log(
    `[shopify] access token refreshed for ${fresh.shop} ` +
      `(expires_in≈${fresh.expires_in}s)`
  );
  return {
    shop: fresh.shop,
    access_token: fresh.access_token,
    scope: fresh.scope,
    expires_at: fresh.expires_at,
  };
}

export async function ensureAdminToken({ forceRefresh = false } = {}) {
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
    !forceRefresh &&
    auth &&
    auth.access_token &&
    (!Number.isFinite(expMs) || expMs - Date.now() > EXPIRY_SKEW_MS);
  if (stillValid) return auth;

  // Single-flight refresh so concurrent order webhooks share one grant.
  if (!refreshInFlight) {
    refreshInFlight = refreshClientCredentialsToken(
      (auth && auth.shop) || config.shopify.shopDomain
    ).finally(() => {
      refreshInFlight = null;
    });
  }
  const refreshed = await refreshInFlight;
  if (refreshed) return refreshed;

  // Could not refresh — better to try a stale token than fail hard.
  return auth && auth.access_token ? auth : null;
}

// Proactive keepalive for Railway: call on a timer so the stored
// client-credentials token never sits expired between quiet periods.
export async function keepShopifyTokenAlive() {
  if (config.shopify.adminToken) {
    return { ok: true, mode: 'static' };
  }
  const auth = await ensureAdminToken();
  if (auth && auth.access_token) {
    return {
      ok: true,
      mode: 'client_credentials',
      expires_at: auth.expires_at || null,
    };
  }
  return { ok: false, error: 'NOT_CONNECTED' };
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
    const refreshed = await ensureAdminToken({ forceRefresh: true });
    if (refreshed && refreshed.access_token) {
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
//  Image URL helpers + product image resolution
//
//  Shopify's order webhook line_items usually DON'T carry the
//  product image. We resolve it from the Admin API, then public
//  catalog fallbacks. Protocol-relative CDN URLs are normalized
//  to https so Meta accepts them as IMAGE header links.
// ------------------------------------------------------------
export function normalizeShopifyImageUrl(input) {
  if (input == null) return '';
  let s = String(input).trim();
  if (!s) return '';
  if (s.startsWith('//')) s = `https:${s}`;
  if (/^cdn\.shopify\.com\//i.test(s)) s = `https://${s}`;
  if (!/^https?:\/\//i.test(s)) return '';
  return s.replace(/[\r\n\t\s]+/g, '');
}

function pickImageSrcFromProduct(product, variantId = '') {
  if (!product || typeof product !== 'object') return '';
  const images = Array.isArray(product.images) ? product.images : [];
  if (variantId && Array.isArray(product.variants)) {
    const v = product.variants.find((x) => String(x.id) === String(variantId));
    if (v && v.image_id) {
      const vi = images.find((im) => String(im.id) === String(v.image_id));
      if (vi && vi.src) return normalizeShopifyImageUrl(vi.src);
    }
  }
  if (product.image && product.image.src) {
    return normalizeShopifyImageUrl(product.image.src);
  }
  if (images[0] && images[0].src) {
    return normalizeShopifyImageUrl(images[0].src);
  }
  return '';
}

function imageFromLineItem(li) {
  if (!li || typeof li !== 'object') return '';
  const candidates = [
    li.image && (li.image.src || li.image.url || li.image),
    li.image_url,
    li.product_image,
    li.featured_image && (li.featured_image.src || li.featured_image.url),
  ];
  for (const c of candidates) {
    const u = normalizeShopifyImageUrl(c);
    if (u) return u;
  }
  return '';
}

// Public storefront catalog fallback. Paginate products.json so we
// do not miss products beyond the first 250 (previous hard limit).
async function fetchPublicCatalogProduct(productId) {
  const shop = config.shopify.shopDomain;
  if (!isValidShop(shop) || !productId) return null;
  const target = String(productId);

  try {
    // page 1..10 * 250 = up to 2500 products without Admin auth.
    for (let page = 1; page <= 10; page++) {
      const response = await fetchWithTimeout(
        `https://${shop}/products.json?limit=250&page=${page}`
      );
      if (!response.ok) return null;
      const catalog = safeJsonParse(await response.text(), null);
      const products = Array.isArray(catalog && catalog.products)
        ? catalog.products
        : [];
      if (!products.length) return null;
      const found = products.find((p) => String(p.id) === target);
      if (found) return found;
      if (products.length < 250) return null; // last page
    }
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') return null;
    throw error;
  }
  return null;
}

// Public product JSON by handle when present on the line item.
async function fetchPublicProductByHandle(handle) {
  const shop = config.shopify.shopDomain;
  const h = String(handle || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!isValidShop(shop) || !h) return null;
  try {
    const response = await fetchWithTimeout(
      `https://${shop}/products/${encodeURIComponent(h)}.json`
    );
    if (!response.ok) return null;
    const json = safeJsonParse(await response.text(), null);
    return (json && json.product) || null;
  } catch {
    return null;
  }
}

async function fetchProductById(productId, handle = '') {
  if (productId) {
    const response = await adminApiGet(
      `products/${productId}.json?fields=id,image,images,options,variants,handle`
    );
    if (response.ok && response.data && response.data.product) {
      return response.data.product;
    }
  }

  // Some Shopify app installations grant order access without product
  // access, or the token is briefly unavailable. Fall back to public
  // catalog endpoints that do not need Admin auth.
  if (handle) {
    const byHandle = await fetchPublicProductByHandle(handle);
    if (byHandle) return byHandle;
  }
  if (productId) {
    return fetchPublicCatalogProduct(productId);
  }
  return null;
}

export async function fetchProductImageUrl(order) {
  try {
    const items = Array.isArray(order && order.line_items)
      ? order.line_items
      : [];
    // Prefer any image already present on line items (some API shapes).
    for (const li of items) {
      const direct = imageFromLineItem(li);
      if (direct) return direct;
    }

    const li =
      items.find((x) => x && (x.product_id || x.handle || x.product_handle)) ||
      null;
    if (!li) return '';

    const productId = li.product_id ? String(li.product_id) : '';
    const variantId = li.variant_id ? String(li.variant_id) : '';
    const handle = li.handle || li.product_handle || '';

    const p = await fetchProductById(productId, handle);
    return pickImageSrcFromProduct(p, variantId);
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
    const getProduct = async (pid, handle = '') => {
      const key = pid ? `id:${pid}` : handle ? `h:${handle}` : '';
      if (!key) return null;
      if (cache.has(key)) return cache.get(key);
      const p = await fetchProductById(pid, handle);
      cache.set(key, p || null);
      return p;
    };

    // Normalize any pre-attached URL; also accept line-item images.
    if (order.productImageUrl) {
      order.productImageUrl =
        normalizeShopifyImageUrl(order.productImageUrl) || order.productImageUrl;
    }
    let imageSet = Boolean(normalizeShopifyImageUrl(order.productImageUrl));
    if (!imageSet) {
      for (const li of items) {
        const direct = imageFromLineItem(li);
        if (direct) {
          order.productImageUrl = direct;
          imageSet = true;
          break;
        }
      }
    }

    const lines = [];

    // Cap to avoid hundreds of sequential Admin API calls on a
    // pathological order (Shopify rate-limits ~2 req/s).
    for (const li of items.slice(0, 25)) {
      const qty = li.quantity || 1;
      const title = norm(li.title || li.name) || 'item';
      const pid = li.product_id ? String(li.product_id) : '';
      const handle = li.handle || li.product_handle || '';
      const p = await getProduct(pid, handle);

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
          const src = pickImageSrcFromProduct(
            p,
            li.variant_id ? String(li.variant_id) : ''
          );
          if (src) {
            order.productImageUrl = src;
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

    // Final image pass if enrichment still missed it.
    if (!normalizeShopifyImageUrl(order.productImageUrl)) {
      const url = await fetchProductImageUrl(order);
      if (url) order.productImageUrl = url;
    }
  } catch (err) {
    console.warn(
      `[shopify] enrichOrderFromShopify failed: ${
        (err && err.message) || err
      }`
    );
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
    const refreshed = await ensureAdminToken({ forceRefresh: true });
    if (refreshed && refreshed.access_token) {
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
//  Order status lifecycle — three mutually-exclusive WhatsApp
//  statuses tracked as Shopify order tags. An order ends up with
//  at most ONE of these at a time (confirm/cancel are final;
//  pending never overrides a final state).
// ------------------------------------------------------------
// Canonical status tags: English text + an emoji prefix so they're
// visually distinguishable in the Shopify order list (Shopify can't
// color tags, but an emoji inside the tag text shows up clearly).
export const CONFIRM_TAG = '✅ WhatsApp Confirmed';
export const PENDING_TAG = '⏳ Pending Confirmation';
export const CANCEL_TAG = '❌ WhatsApp Cancelled';

// Call-desk tags (set by operators in Shopify) — must drive the same
// lifecycle status as the WhatsApp tags. Exact strings + flexible
// regex matching so emoji variants still resolve.
const CONFIRM_ALIASES = [
  CONFIRM_TAG,
  'WhatsApp Confirmed',
  '✅ Call Confirmed',
  'Call Confirmed',
];
const PENDING_ALIASES = [PENDING_TAG, 'Pending Confirmation'];
const CANCEL_ALIASES = [
  CANCEL_TAG,
  'WhatsApp Cancelled',
  '❌ Call Cancelled',
  'Call Cancelled',
];
export const ALL_STATUS_ALIASES = [
  ...CONFIRM_ALIASES,
  ...PENDING_ALIASES,
  ...CANCEL_ALIASES,
];

// Strip emoji / variation selectors so "✅ Call Confirmed" and
// "Call Confirmed" match the same pattern.
function normalizeStatusTag(tag) {
  return String(tag || '')
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagsMatchAny(tagList, aliases, patterns) {
  const lcExact = new Set(
    tagList.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean)
  );
  const norms = tagList.map(normalizeStatusTag).filter(Boolean);
  for (const a of aliases) {
    if (lcExact.has(String(a).toLowerCase())) return true;
    const na = normalizeStatusTag(a);
    if (na && norms.includes(na)) return true;
  }
  for (const n of norms) {
    for (const re of patterns) {
      if (re.test(n)) return true;
    }
  }
  return false;
}

// Pure tag → status. Precedence confirmed > cancelled > pending.
// Recognises WhatsApp lifecycle tags AND operator Call Confirmed /
// Call Cancelled tags (e.g. order #5595FY, #5585FY).
export function statusFromTags(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map((t) => String(t || '').trim())
    .filter(Boolean);

  if (
    tagsMatchAny(list, CONFIRM_ALIASES, [
      /\bwhatsapp\s*confirmed\b/,
      /\bcall\s*confirmed\b/,
    ])
  ) {
    return 'confirmed';
  }
  if (
    tagsMatchAny(list, CANCEL_ALIASES, [
      /\bwhatsapp\s*cancelled\b/,
      /\bcall\s*cancelled\b/,
    ])
  ) {
    return 'cancelled';
  }
  if (
    tagsMatchAny(list, PENDING_ALIASES, [/\bpending\s*confirmation\b/])
  ) {
    return 'pending';
  }
  return 'none';
}

// ------------------------------------------------------------
//  setOrderStatusTags(orderId, { add=[], remove=[] })
//
//  Generic, idempotent tag mutator. Fetches the order, parses the
//  comma-separated `tags`, removes everything in `remove[]`
//  (case-insensitive) and adds everything in `add[]` that is not
//  already present (case-insensitive). Exact casing on write.
//  Never throws — returns { ok, tags } or { ok:false, error }.
// ------------------------------------------------------------
export async function setOrderStatusTags(orderId, { add = [], remove = [] } = {}) {
  try {
    const got = await fetchOrderById(orderId);
    if (!got.ok) return { ok: false, error: got.error, message: got.message };
    const o = got.order;

    const removeLc = new Set(
      (Array.isArray(remove) ? remove : [])
        .map((t) => String(t || '').trim().toLowerCase())
        .filter(Boolean)
    );
    const addList = (Array.isArray(add) ? add : [])
      .map((t) => String(t || '').trim())
      .filter(Boolean);

    let tags = String(o.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => !removeLc.has(t.toLowerCase()));

    for (const t of addList) {
      if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
        tags.push(t);
      }
    }

    const nextTags = tags.join(', ');
    const res = await adminApiSend('PUT', `orders/${o.id}.json`, {
      order: { id: o.id, tags: nextTags },
    });
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
    const saved = (res.data && res.data.order) || null;
    return { ok: true, tags: saved ? saved.tags : nextTags, order: saved };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err.message };
  }
}

// ------------------------------------------------------------
//  confirmShopifyOrder(orderId) — final state CONFIRMED.
//  Adds CONFIRM_TAG and clears PENDING_TAG + CANCEL_TAG so a
//  confirmation always wins over a prior pending/cancelled state.
//  Keeps the existing return shape + `alreadyConfirmed` behavior.
// ------------------------------------------------------------
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
  // Remove every status alias (legacy + canonical) then add the
  // canonical confirmed tag → normalises old plain tags too.
  const res = await setOrderStatusTags(o.id, {
    add: [CONFIRM_TAG],
    remove: ALL_STATUS_ALIASES,
  });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  return { ok: true, order: res.order };
}

// ------------------------------------------------------------
//  cancelShopifyOrder(orderId) — final state CANCELLED.
//  Adds CANCEL_TAG and clears PENDING_TAG + CONFIRM_TAG. Same
//  shape as confirmShopifyOrder (+ `alreadyCancelled`).
// ------------------------------------------------------------
export async function cancelShopifyOrder(orderId) {
  const got = await fetchOrderById(orderId);
  if (!got.ok) return { ok: false, error: got.error, message: got.message };
  const o = got.order;
  const existing = String(o.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (existing.some((t) => t.toLowerCase() === CANCEL_TAG.toLowerCase())) {
    return { ok: true, alreadyCancelled: true, order: o };
  }
  const res = await setOrderStatusTags(o.id, {
    add: [CANCEL_TAG],
    remove: ALL_STATUS_ALIASES,
  });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  return { ok: true, order: res.order };
}

// ------------------------------------------------------------
//  markOrderPending(orderId) — soft state PENDING.
//  Adds PENDING_TAG ONLY IF the order has NO final state
//  (no CONFIRM_TAG and no CANCEL_TAG). Never overrides a final
//  state; no-op otherwise. Returns quietly (best effort).
// ------------------------------------------------------------
export async function markOrderPending(orderId) {
  try {
    const got = await fetchOrderById(orderId);
    if (!got.ok) return { ok: false, error: got.error, skipped: true };
    const o = got.order;
    // Any existing status (legacy or canonical) → no-op; never
    // override a confirmed/cancelled/pending state.
    if (statusFromTags(o.tags) !== 'none') {
      return { ok: true, skipped: true };
    }
    return await setOrderStatusTags(o.id, { add: [PENDING_TAG] });
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err.message };
  }
}

// ------------------------------------------------------------
//  getOrderItemsDetailed(order) -> [{ qty, title, size, color,
//  imageUrl }]  (one entry per line item, with the variant image)
//  imageUrl is always absolute https and prefers PNG via Shopify CDN
//  conversion so WhatsApp free-form image messages deliver reliably.
// ------------------------------------------------------------
export async function getOrderItemsDetailed(order) {
  const items = Array.isArray(order && order.line_items)
    ? order.line_items
    : [];
  const norm = (s) => String(s == null ? '' : s).trim();
  const cache = new Map();
  const getProduct = async (pid, handle = '') => {
    const key = pid ? `id:${pid}` : handle ? `h:${handle}` : '';
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    // Reuse the shared product fetcher (Admin API + public catalog).
    const p = await fetchProductById(pid, handle);
    cache.set(key, p || null);
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
    // Line-item images first (some payloads carry them).
    imageUrl =
      normalizeShopifyImageUrl(
        (li.image && (li.image.src || li.image.url || li.image)) ||
          li.image_url ||
          li.product_image ||
          ''
      ) || '';

    const pid = li.product_id ? String(li.product_id) : '';
    const handle = li.handle || li.product_handle || '';
    const p = await getProduct(pid, handle);
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
      if (!imageUrl) {
        imageUrl = pickImageSrcFromProduct(
          p,
          li.variant_id ? String(li.variant_id) : ''
        );
      }
    }
    if (!size && !color && norm(li.variant_title)) {
      // last resort label-less
      size = norm(li.variant_title);
    }
    // Force https + PNG format for Shopify CDN so WhatsApp accepts it.
    if (imageUrl) {
      let safe = normalizeShopifyImageUrl(imageUrl);
      if (/cdn\.shopify\.com|\/cdn\/shop\//i.test(safe)) {
        try {
          const u = new URL(safe);
          u.searchParams.set('format', 'png');
          if (!u.searchParams.has('width')) u.searchParams.set('width', '1200');
          safe = u.toString();
        } catch {
          safe = safe.includes('?') ? `${safe}&format=png` : `${safe}?format=png`;
        }
      }
      imageUrl = safe;
    }
    out.push({
      qty,
      title,
      size,
      color,
      imageUrl,
      productId: pid,
      variantId: li.variant_id ? String(li.variant_id) : '',
    });
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
  keepShopifyTokenAlive,
  adminApiGet,
  adminApiSend,
  fetchLatestOrder,
  fetchOrderById,
  confirmShopifyOrder,
  cancelShopifyOrder,
  markOrderPending,
  setOrderStatusTags,
  getOrderItemsDetailed,
  fetchProductImageUrl,
  enrichOrderFromShopify,
  normalizeShopifyImageUrl,
  CONFIRM_TAG,
  PENDING_TAG,
  CANCEL_TAG,
  OAUTH_SCOPES,
  ADMIN_API_VERSION,
};
