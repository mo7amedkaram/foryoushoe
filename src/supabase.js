// ============================================================
//  src/supabase.js
//  Supabase client factory + config/log helpers.
//
//  Degraded mode: when Supabase env vars are missing the app keeps
//  config in memory and skips persisting the message log so that the
//  UI and the full send pipeline still work for testing.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

const CONFIG_ROW_ID = 1; // single-row config table
const SHOPIFY_AUTH_ROW_ID = 1; // single-row shopify_auth table

let client = null;
if (config.supabase.enabled) {
  try {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false },
    });
    console.log('[supabase] connected.');
  } catch (err) {
    console.warn('[supabase] failed to create client, falling back to memory:', err.message);
    client = null;
  }
} else {
  console.warn(
    '[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. ' +
      'Running in degraded mode: config in memory, message log NOT persisted.'
  );
}

export function isSupabaseEnabled() {
  return Boolean(client);
}

// ---- In-memory fallback stores ----
const memory = {
  config: {
    settings: {
      store_name: config.defaults.storeName,
      default_country_code: config.defaults.defaultCountryCode,
      recipient_phone_source: config.defaults.recipientPhoneSource,
    },
    mapping: {}, // { templateVariableName: { type: 'resolver'|'static', value: '...' } }
    selected_template_id: '',
    phone_number_id: config.joud.phoneNumberId,
  },
  logs: [],
  // Offline Shopify OAuth token (fallback when Supabase is degraded).
  shopifyAuth: null, // { shop, access_token, scope, obtained_at }
};

// ------------------------------------------------------------
//  getConfig() -> { settings, mapping, selected_template_id, phone_number_id }
// ------------------------------------------------------------
export async function getConfig() {
  if (!client) {
    return structuredClone(memory.config);
  }
  try {
    const { data, error } = await client
      .from('app_config')
      .select('settings, mapping, selected_template_id, phone_number_id')
      .eq('id', CONFIG_ROW_ID)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      // No row yet -> seed with defaults.
      return structuredClone(memory.config);
    }
    return {
      settings: data.settings || structuredClone(memory.config.settings),
      mapping: data.mapping || {},
      selected_template_id: data.selected_template_id || '',
      phone_number_id: data.phone_number_id || config.joud.phoneNumberId,
    };
  } catch (err) {
    console.warn('[supabase] getConfig failed, using memory:', err.message);
    return structuredClone(memory.config);
  }
}

// ------------------------------------------------------------
//  saveConfig(partial) -> persisted config
//  partial may contain any of: settings, mapping,
//  selected_template_id, phone_number_id
// ------------------------------------------------------------
export async function saveConfig(partial = {}) {
  const current = await getConfig();
  const next = {
    settings: { ...current.settings, ...(partial.settings || {}) },
    mapping: partial.mapping !== undefined ? partial.mapping : current.mapping,
    selected_template_id:
      partial.selected_template_id !== undefined
        ? partial.selected_template_id
        : current.selected_template_id,
    phone_number_id:
      partial.phone_number_id !== undefined
        ? partial.phone_number_id
        : current.phone_number_id,
  };

  // Always keep the memory copy in sync (used as fallback).
  memory.config = structuredClone(next);

  if (!client) return next;

  try {
    const { error } = await client.from('app_config').upsert(
      {
        id: CONFIG_ROW_ID,
        settings: next.settings,
        mapping: next.mapping,
        selected_template_id: next.selected_template_id,
        phone_number_id: next.phone_number_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
    if (error) throw error;
  } catch (err) {
    console.warn('[supabase] saveConfig failed (kept in memory):', err.message);
  }
  return next;
}

// ------------------------------------------------------------
//  insertLog(record)
// ------------------------------------------------------------
export async function insertLog(record) {
  const row = {
    created_at: new Date().toISOString(),
    shopify_order_id: record.shopify_order_id ? String(record.shopify_order_id) : null,
    order_number: record.order_number ? String(record.order_number) : null,
    recipient_phone: record.recipient_phone || null,
    template_id: record.template_id ? String(record.template_id) : null,
    variables: record.variables || {},
    success: Boolean(record.success),
    response: record.response != null ? String(record.response).slice(0, 8000) : null,
  };

  // Memory copy (capped) so the UI shows logs even in degraded mode.
  memory.logs.unshift(row);
  if (memory.logs.length > 200) memory.logs.length = 200;

  if (!client) return row;

  try {
    const { error } = await client.from('message_log').insert(row);
    if (error) throw error;
  } catch (err) {
    console.warn('[supabase] insertLog failed (kept in memory):', err.message);
  }
  return row;
}

// ------------------------------------------------------------
//  listLogs(limit)
// ------------------------------------------------------------
export async function listLogs(limit = 50) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  if (!client) {
    return memory.logs.slice(0, n);
  }
  try {
    const { data, error } = await client
      .from('message_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(n);
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn('[supabase] listLogs failed, using memory:', err.message);
    return memory.logs.slice(0, n);
  }
}

// ------------------------------------------------------------
//  listLogsPaged({ page, limit, onlyFailed }) ->
//    { rows, total, page, limit }
//
//  Paginated message-log view used by the monitoring UI. Newest
//  first; optional `onlyFailed` filter for error monitoring.
//  Mirrors the in-memory fallback semantics exactly so the UI
//  behaves the same in degraded mode.
// ------------------------------------------------------------
export async function listLogsPaged({ page = 1, limit = 20, onlyFailed = false } = {}) {
  const p = Math.max(parseInt(page, 10) || 1, 1);
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const failedOnly = Boolean(onlyFailed);
  const from = (p - 1) * n;
  const to = from + n - 1;

  if (!client) {
    const all = failedOnly
      ? memory.logs.filter((l) => l.success === false)
      : memory.logs;
    return {
      rows: all.slice(from, from + n),
      total: all.length,
      page: p,
      limit: n,
    };
  }
  try {
    let q = client
      .from('message_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (failedOnly) q = q.eq('success', false);
    const { data, error, count } = await q;
    if (error) throw error;
    return {
      rows: data || [],
      total: typeof count === 'number' ? count : (data ? data.length : 0),
      page: p,
      limit: n,
    };
  } catch (err) {
    console.warn('[supabase] listLogsPaged failed, using memory:', err.message);
    const all = failedOnly
      ? memory.logs.filter((l) => l.success === false)
      : memory.logs;
    return {
      rows: all.slice(from, from + n),
      total: all.length,
      page: p,
      limit: n,
    };
  }
}

// ------------------------------------------------------------
//  successfulOrderIdSet(limit) -> Set<string>
//
//  One query that returns the set of shopify_order_id values that
//  have at least one successful message_log row. Used to annotate
//  the unconfirmed-orders list with `alreadySent` WITHOUT calling
//  hasSuccessfulLog per order in a loop.
// ------------------------------------------------------------
export async function successfulOrderIdSet(limit = 1000) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000);

  if (!client) {
    const set = new Set();
    for (const l of memory.logs) {
      if (l.success === true && l.shopify_order_id) {
        set.add(String(l.shopify_order_id));
      }
    }
    return set;
  }
  try {
    const { data, error } = await client
      .from('message_log')
      .select('shopify_order_id')
      .eq('success', true)
      .not('shopify_order_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(n);
    if (error) throw error;
    const set = new Set();
    for (const r of data || []) {
      if (r && r.shopify_order_id) set.add(String(r.shopify_order_id));
    }
    return set;
  } catch (err) {
    console.warn('[supabase] successfulOrderIdSet failed, using memory:', err.message);
    const set = new Set();
    for (const l of memory.logs) {
      if (l.success === true && l.shopify_order_id) {
        set.add(String(l.shopify_order_id));
      }
    }
    return set;
  }
}

// ------------------------------------------------------------
//  hasSuccessfulLog(orderId, templateId) -> boolean
//  Best-effort idempotency check.
// ------------------------------------------------------------
export async function hasSuccessfulLog(orderId, templateId) {
  if (!orderId) return false;
  const oid = String(orderId);
  const tid = templateId ? String(templateId) : null;

  if (!client) {
    return memory.logs.some(
      (l) =>
        l.shopify_order_id === oid &&
        l.success === true &&
        (tid ? l.template_id === tid : true)
    );
  }
  try {
    let q = client
      .from('message_log')
      .select('id', { count: 'exact', head: true })
      .eq('shopify_order_id', oid)
      .eq('success', true);
    if (tid) q = q.eq('template_id', tid);
    const { count, error } = await q;
    if (error) throw error;
    return (count || 0) > 0;
  } catch (err) {
    console.warn('[supabase] hasSuccessfulLog failed:', err.message);
    return false;
  }
}

// ------------------------------------------------------------
//  findRecentOrderByPhone(phone) -> shopify_order_id | null
//  Correlates an inbound WhatsApp button click (from a phone) to
//  the most recent order we sent that phone.
// ------------------------------------------------------------
export async function findRecentOrderByPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (!p) return null;

  if (!client) {
    const hit = memory.logs.find(
      (l) =>
        String(l.recipient_phone || '').replace(/\D/g, '') === p &&
        l.shopify_order_id
    );
    return hit ? hit.shopify_order_id : null;
  }
  try {
    const { data, error } = await client
      .from('message_log')
      .select('shopify_order_id, recipient_phone, created_at')
      .eq('recipient_phone', p)
      .not('shopify_order_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return data && data[0] ? data[0].shopify_order_id : null;
  } catch (err) {
    console.warn('[supabase] findRecentOrderByPhone failed:', err.message);
    const hit = memory.logs.find(
      (l) =>
        String(l.recipient_phone || '').replace(/\D/g, '') === p &&
        l.shopify_order_id
    );
    return hit ? hit.shopify_order_id : null;
  }
}

// ------------------------------------------------------------
//  getShopifyAuth() -> { shop, access_token, scope, obtained_at }|null
//
//  Returns the stored OFFLINE Shopify OAuth token, or null when the
//  store has not been connected yet.
// ------------------------------------------------------------
export async function getShopifyAuth() {
  if (!client) {
    return memory.shopifyAuth ? structuredClone(memory.shopifyAuth) : null;
  }
  try {
    const { data, error } = await client
      .from('shopify_auth')
      .select('shop, access_token, scope, obtained_at, expires_at')
      .eq('id', SHOPIFY_AUTH_ROW_ID)
      .maybeSingle();

    if (error) throw error;
    if (!data || !data.access_token) {
      return memory.shopifyAuth ? structuredClone(memory.shopifyAuth) : null;
    }
    return {
      shop: data.shop || '',
      access_token: data.access_token,
      scope: data.scope || '',
      obtained_at: data.obtained_at || null,
      expires_at: data.expires_at || null,
    };
  } catch (err) {
    console.warn('[supabase] getShopifyAuth failed, using memory:', err.message);
    return memory.shopifyAuth ? structuredClone(memory.shopifyAuth) : null;
  }
}

// ------------------------------------------------------------
//  saveShopifyAuth({ shop, access_token, scope }) -> stored row
//
//  Persists the offline token (single row id=1). Never throws;
//  always keeps a memory copy as a fallback.
// ------------------------------------------------------------
export async function saveShopifyAuth({ shop, access_token, scope, expires_at }) {
  const now = new Date().toISOString();
  const next = {
    shop: shop ? String(shop) : '',
    access_token: access_token ? String(access_token) : '',
    scope: scope ? String(scope) : '',
    obtained_at: now,
    expires_at: expires_at ? String(expires_at) : null,
  };

  // Always keep the memory copy in sync (fallback).
  memory.shopifyAuth = structuredClone(next);

  if (!client) return next;

  try {
    const { error } = await client.from('shopify_auth').upsert(
      {
        id: SHOPIFY_AUTH_ROW_ID,
        shop: next.shop,
        access_token: next.access_token,
        scope: next.scope,
        obtained_at: next.obtained_at,
        expires_at: next.expires_at,
        updated_at: now,
      },
      { onConflict: 'id' }
    );
    if (error) throw error;
  } catch (err) {
    console.warn('[supabase] saveShopifyAuth failed (kept in memory):', err.message);
  }
  return next;
}

export default {
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
};
