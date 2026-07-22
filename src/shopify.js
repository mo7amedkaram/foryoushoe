// ============================================================
//  src/shopify.js
//  - Webhook HMAC verification (timing-safe)
//  - Shopify-order -> template-variable resolver registry
// ============================================================
import crypto from 'node:crypto';
import { config } from './config.js';

// ------------------------------------------------------------
//  verifyWebhookHmac(rawBody, hmacHeader, secret)
//
//  Shopify signs the webhook by computing
//    base64( HMAC-SHA256( rawRequestBody, sharedSecret ) )
//  and sending it in the `X-Shopify-Hmac-Sha256` header.
//
//  We MUST hash the *exact raw bytes* of the body (not the
//  re-serialized JSON), and compare in constant time.
// ------------------------------------------------------------
export function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  if (rawBody == null) return false;

  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');

  const digest = crypto
    .createHmac('sha256', secret)
    .update(bodyBuf)
    .digest('base64');

  // Constant-time comparison. Buffers must be equal length, otherwise
  // timingSafeEqual throws -> treat as mismatch.
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(hmacHeader), 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
//  Address formatter
// ------------------------------------------------------------
function formatAddress(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const parts = [
    addr.address1,
    addr.address2,
    addr.city,
    addr.province,
    addr.country,
    addr.zip,
  ]
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter((p) => p !== '');
  return parts.join(', ');
}

function fullName(obj) {
  if (!obj) return '';
  const fn = (obj.first_name || '').trim();
  const ln = (obj.last_name || '').trim();
  return `${fn} ${ln}`.trim();
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return [v];
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = String(v == null ? '' : v).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// Pull tracking data from Shopify order fulfillments. Shopify can
// expose both singular and plural tracking fields; prefer the newest
// fulfillment with a URL/number, but retain all unique values for
// body text when there are multiple shipments.
export function extractTrackingDetails(order) {
  const fulfillments = Array.isArray(order && order.fulfillments)
    ? order.fulfillments.slice()
    : [];

  fulfillments.sort((a, b) => {
    const ta =
      Date.parse((a && (a.updated_at || a.created_at)) || '') || 0;
    const tb =
      Date.parse((b && (b.updated_at || b.created_at)) || '') || 0;
    return tb - ta;
  });

  const numbers = [];
  const urls = [];
  const companies = [];
  for (const f of fulfillments) {
    if (!f || typeof f !== 'object') continue;
    numbers.push(...asArray(f.tracking_numbers), f.tracking_number);
    urls.push(...asArray(f.tracking_urls), f.tracking_url);
    companies.push(f.tracking_company);
  }

  const trackingNumbers = uniqueStrings(numbers);
  const trackingUrls = uniqueStrings(urls).filter((u) => /^https?:\/\//i.test(u));
  const trackingCompanies = uniqueStrings(companies);

  return {
    trackingNumber: trackingNumbers[0] || '',
    trackingNumbers,
    trackingLink: trackingUrls[0] || '',
    trackingUrl: trackingUrls[0] || '',
    trackingUrls,
    trackingCompany: trackingCompanies[0] || '',
    trackingCompanies,
  };
}

// ------------------------------------------------------------
//  Phone normalization
//
//  Heuristic (documented in README):
//   1. Strip spaces, dashes, parentheses, dots.
//   2. Strip a leading '+'.
//   3. If it starts with "00" -> drop the "00" (international prefix).
//   4. If it then starts with "0" -> treat as a LOCAL number:
//      drop the leading 0 and prepend DEFAULT_COUNTRY_CODE.
//   5. Else if it is short (< 11 digits) and does NOT already start
//      with the country code -> assume local, prepend country code.
//   6. Otherwise assume it already includes the country code.
//  Result: digits only, no '+'.
// ------------------------------------------------------------
export function normalizePhone(input, countryCode) {
  if (!input) return '';
  const cc = String(countryCode || config.defaults.defaultCountryCode).replace(/\D/g, '');
  let s = String(input).trim();

  // 1. keep digits and a possible leading +
  s = s.replace(/[()\-\s.]/g, '');
  // 2. strip leading +
  s = s.replace(/^\+/, '');
  // keep digits only after this point
  s = s.replace(/\D/g, '');
  if (!s) return '';

  // 3. drop international "00" prefix
  if (s.startsWith('00')) {
    s = s.slice(2);
    return s; // already in full international form
  }

  // 4. local number starting with 0
  if (s.startsWith('0')) {
    return cc + s.replace(/^0+/, '');
  }

  // 5. already starts with the country code -> keep as-is
  if (cc && s.startsWith(cc)) {
    return s;
  }

  // 5b. short number, assume local -> prepend country code
  if (s.length < 11) {
    return cc + s;
  }

  // 6. assume already international
  return s;
}

// ------------------------------------------------------------
//  Resolver registry
//  Each resolver: (order, settings) => string
//  Keyed by a stable id used by the UI mapping dropdowns.
// ------------------------------------------------------------
export const resolvers = {
  storeName: {
    label: 'Store name',
    fn: (order, settings) => {
      const fromSettings =
        settings && settings.store_name != null
          ? String(settings.store_name).trim()
          : '';
      // Ignore accidental saves of the raw Shopify subdomain slug.
      const looksLikeShopifySlug =
        /^[a-z0-9]+(-[a-z0-9]+)+$/i.test(fromSettings) &&
        !/\s/.test(fromSettings);
      if (fromSettings && !looksLikeShopifySlug) return fromSettings;
      return config.defaults.storeName || fromSettings || '';
    },
  },
  customerName: {
    label: 'Customer name',
    fn: (order) => {
      const c = fullName(order.customer);
      if (c) return c;
      if (order.shipping_address && order.shipping_address.name)
        return String(order.shipping_address.name).trim();
      if (order.billing_address && order.billing_address.name)
        return String(order.billing_address.name).trim();
      return '';
    },
  },
  orderId: {
    label: 'Order ID',
    fn: (order) => (order.id != null ? String(order.id) : ''),
  },
  orderNumber: {
    label: 'Order number',
    fn: (order) =>
      order.name != null
        ? String(order.name)
        : order.order_number != null
        ? String(order.order_number)
        : '',
  },
  orderDescription: {
    label: 'Order description (line items + size/color)',
    fn: (order) => {
      // Enriched form (qty x title + المقاس + اللون) is built from the
      // Shopify product/variant during order enrichment.
      if (order && order.formattedDescription) {
        return String(order.formattedDescription);
      }
      const items = Array.isArray(order.line_items) ? order.line_items : [];
      return items
        .map((li) => {
          const base = `${li.quantity || 1}x ${li.title || li.name || 'item'}`;
          const vt = (li.variant_title || '').trim();
          return vt ? `${base} - ${vt}` : base;
        })
        .join(', ');
    },
  },
  orderCost: {
    label: 'Order total + currency',
    fn: (order) => {
      const total =
        order.total_price ??
        (order.current_total_price_set &&
          order.current_total_price_set.shop_money &&
          order.current_total_price_set.shop_money.amount) ??
        '';
      const cur = order.currency || '';
      return `${total} ${cur}`.trim();
    },
  },
  orderStatus: {
    label: 'Order status',
    fn: (order) =>
      order.fulfillment_status ||
      order.financial_status ||
      'pending',
  },
  customerAddress: {
    label: 'Shipping address',
    fn: (order) => formatAddress(order.shipping_address),
  },
  otherAddress: {
    label: 'Billing address',
    fn: (order) => formatAddress(order.billing_address),
  },
  customerCity: {
    label: 'City (المدينة)',
    fn: (order) => {
      const s = order.shipping_address || {};
      const b = order.billing_address || {};
      return String(s.city || b.city || '').trim();
    },
  },
  customerGovernorate: {
    label: 'Governorate / Province (المحافظة)',
    fn: (order) => {
      const s = order.shipping_address || {};
      const b = order.billing_address || {};
      return String(s.province || s.province_code || b.province || '').trim();
    },
  },
  productImage: {
    label: 'Product image / link (صورة المنتج)',
    // The Shopify order payload does NOT carry the product image, so
    // processOrder / the preview enrich the order with
    // `productImageUrl` (resolved via the Admin API). Prefer that;
    // fall back to any image fields that happen to be present.
    // Protocol-relative CDN URLs ("//cdn...") are upgraded to https.
    fn: (order) => {
      const norm = (u) => {
        if (u == null) return '';
        let s = String(u).trim();
        if (!s) return '';
        if (s.startsWith('//')) s = `https:${s}`;
        return /^https?:\/\//i.test(s) ? s : '';
      };
      if (order && order.productImageUrl) {
        const u = norm(order.productImageUrl);
        if (u) return u;
      }
      const items = Array.isArray(order.line_items) ? order.line_items : [];
      const li = items[0] || {};
      return (
        norm(li.image && (li.image.src || li.image.url || li.image)) ||
        norm(li.image_url) ||
        norm(li.product_image) ||
        ''
      );
    },
  },
  trackingNumber: {
    label: 'Tracking number',
    fn: (order) => {
      const t = extractTrackingDetails(order);
      return t.trackingNumbers.length
        ? t.trackingNumbers.join(', ')
        : t.trackingNumber;
    },
  },
  trackingLink: {
    label: 'Tracking link',
    fn: (order) => extractTrackingDetails(order).trackingLink,
  },
  trackingUrl: {
    label: 'Tracking URL',
    fn: (order) => extractTrackingDetails(order).trackingUrl,
  },
  trackingCompany: {
    label: 'Tracking company',
    fn: (order) => extractTrackingDetails(order).trackingCompany,
  },
};

// List of resolver options for the UI.
export function resolverOptions() {
  return Object.entries(resolvers).map(([id, r]) => ({ id, label: r.label }));
}

// ------------------------------------------------------------
//  pickRecipientPhone(order, settings)
//  Returns a normalized international phone (digits, no '+').
// ------------------------------------------------------------
export function pickRecipientPhone(order, settings) {
  const cc =
    (settings && settings.default_country_code) ||
    config.defaults.defaultCountryCode;
  const source = (settings && settings.recipient_phone_source) || 'auto';

  const candidates = [];
  const customerPhone = order.customer && order.customer.phone;
  const shipPhone = order.shipping_address && order.shipping_address.phone;
  const billPhone = order.billing_address && order.billing_address.phone;

  if (source === 'customer') candidates.push(customerPhone);
  else if (source === 'shipping') candidates.push(shipPhone);
  else if (source === 'billing') candidates.push(billPhone);
  else {
    // auto: first non-empty in priority order
    candidates.push(customerPhone, shipPhone, billPhone, order.phone);
  }

  for (const c of candidates) {
    if (c && String(c).trim() !== '') {
      return normalizePhone(c, cc);
    }
  }
  return '';
}

// ------------------------------------------------------------
//  resolveVariablesForOrder(order, mapping, settings)
//
//  mapping shape:
//    { "<templateVariableName>": { type: 'resolver', value: 'orderId' } }
//    { "<templateVariableName>": { type: 'static',   value: 'Hello' } }
//
//  Returns { values: { name: resolvedString }, missing: [names] }
// ------------------------------------------------------------
export function resolveVariablesForOrder(order, mapping = {}, settings = {}) {
  const values = {};
  const missing = [];

  for (const [varName, def] of Object.entries(mapping || {})) {
    if (!def || typeof def !== 'object') {
      values[varName] = '';
      missing.push(varName);
      continue;
    }
    if (def.type === 'static') {
      values[varName] = def.value == null ? '' : String(def.value);
      continue;
    }
    // default: resolver
    const r = resolvers[def.value];
    if (!r) {
      values[varName] = '';
      missing.push(varName);
      continue;
    }
    try {
      const out = r.fn(order, settings);
      values[varName] = out == null ? '' : String(out);
    } catch (err) {
      values[varName] = '';
      missing.push(varName);
    }
  }

  return { values, missing };
}

export default {
  verifyWebhookHmac,
  normalizePhone,
  extractTrackingDetails,
  resolvers,
  resolverOptions,
  pickRecipientPhone,
  resolveVariablesForOrder,
};
