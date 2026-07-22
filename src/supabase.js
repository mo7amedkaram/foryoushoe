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
  // Durable-enough for single process: claim_key -> claim row
  claims: new Map(),
};

// Stale "claimed" rows older than this may be re-acquired (crashed worker).
const CLAIM_STALE_MS = 10 * 60 * 1000;

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

  // Always check in-process memory first. insertLog writes here even when
  // Supabase is down — without this, catch-up/retry re-sends every order.
  const memHit = memory.logs.some(
    (l) =>
      String(l.shopify_order_id || '') === oid &&
      l.success === true &&
      (tid ? String(l.template_id || '') === tid : true)
  );
  if (memHit) return true;

  // Permanent claim marker (survives multi-instance when Supabase works).
  if (tid) {
    const claimKey = confirmClaimKey(oid, tid);
    const claim = await getSendClaim(claimKey);
    if (claim && claim.status === 'sent') return true;
  }

  if (!client) return false;
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
    console.warn(
      '[supabase] hasSuccessfulLog failed (using memory only):',
      err.message
    );
    // Memory already checked above — do NOT return a false-negative that
    // would cause a duplicate WhatsApp send.
    return false;
  }
}

// ------------------------------------------------------------
//  Send claims — insert-wins idempotency
// ------------------------------------------------------------
export function confirmClaimKey(orderId, templateId) {
  return `confirm:${String(orderId)}:${String(templateId || '')}`;
}

export function webhookClaimKey(webhookId) {
  return `webhook:${String(webhookId)}`;
}

export function inboundClaimKey(messageId) {
  return `inbound:${String(messageId)}`;
}

export function inquiryClaimKey(orderId, messageId) {
  return `inquiry:${String(orderId)}:${String(messageId || 'na')}`;
}

async function getSendClaim(claimKey) {
  const key = String(claimKey || '');
  if (!key) return null;
  if (memory.claims.has(key)) return memory.claims.get(key);
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('send_claims')
      .select('*')
      .eq('claim_key', key)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      memory.claims.set(key, data);
      return data;
    }
  } catch (err) {
    // Table may not exist yet on older deploys — degrade gracefully.
    if (!/relation .* does not exist|Could not find the table/i.test(err.message || '')) {
      console.warn('[supabase] getSendClaim failed:', err.message);
    }
  }
  return null;
}

/**
 * tryAcquireSendClaim({ claimKey, kind, shopifyOrderId, webhookId, templateId })
 * Insert-wins. Returns:
 *   { acquired: true }
 *   { acquired: false, reason: 'already_sent'|'in_progress'|'duplicate', existing }
 */
export async function tryAcquireSendClaim({
  claimKey,
  kind,
  shopifyOrderId = null,
  webhookId = null,
  templateId = null,
} = {}) {
  const key = String(claimKey || '').trim();
  if (!key) return { acquired: false, reason: 'missing_key' };

  const now = Date.now();
  const existing = await getSendClaim(key);
  if (existing) {
    if (existing.status === 'sent') {
      return { acquired: false, reason: 'already_sent', existing };
    }
    if (existing.status === 'claimed') {
      const age =
        now - (Date.parse(existing.updated_at || existing.created_at || '') || 0);
      if (age < CLAIM_STALE_MS) {
        return { acquired: false, reason: 'in_progress', existing };
      }
      // Stale claimed → re-acquire below.
    }
    // failed or stale claimed → allow re-claim
  }

  const row = {
    claim_key: key,
    kind: String(kind || 'confirm'),
    shopify_order_id: shopifyOrderId != null ? String(shopifyOrderId) : null,
    webhook_id: webhookId != null ? String(webhookId) : null,
    template_id: templateId != null ? String(templateId) : null,
    status: 'claimed',
    message_id: null,
    response: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Memory acquire (single-process / degraded mode).
  const mem = memory.claims.get(key);
  if (mem && mem.status === 'sent') {
    return { acquired: false, reason: 'already_sent', existing: mem };
  }
  if (mem && mem.status === 'claimed') {
    const age = now - (Date.parse(mem.updated_at || mem.created_at || '') || 0);
    if (age < CLAIM_STALE_MS) {
      return { acquired: false, reason: 'in_progress', existing: mem };
    }
  }
  memory.claims.set(key, { ...row });

  if (!client) return { acquired: true, claim: row };

  try {
    // Prefer insert; on conflict inspect existing row.
    const { error } = await client.from('send_claims').insert(row);
    if (!error) return { acquired: true, claim: row };

    // Unique violation or other conflict — read winner.
    const { data: winner, error: selErr } = await client
      .from('send_claims')
      .select('*')
      .eq('claim_key', key)
      .maybeSingle();
    if (selErr) throw selErr;
    if (winner) {
      memory.claims.set(key, winner);
      if (winner.status === 'sent') {
        return { acquired: false, reason: 'already_sent', existing: winner };
      }
      if (winner.status === 'claimed') {
        const age =
          now - (Date.parse(winner.updated_at || winner.created_at || '') || 0);
        if (age < CLAIM_STALE_MS) {
          return { acquired: false, reason: 'in_progress', existing: winner };
        }
        // Re-claim stale row.
        const { error: upErr } = await client
          .from('send_claims')
          .update({
            status: 'claimed',
            updated_at: new Date().toISOString(),
            message_id: null,
            response: null,
          })
          .eq('claim_key', key)
          .eq('status', 'claimed');
        if (!upErr) {
          memory.claims.set(key, { ...winner, status: 'claimed' });
          return { acquired: true, claim: { ...winner, status: 'claimed' } };
        }
        return { acquired: false, reason: 'in_progress', existing: winner };
      }
      // failed → update to claimed
      const { error: up2 } = await client
        .from('send_claims')
        .update({
          status: 'claimed',
          updated_at: new Date().toISOString(),
          message_id: null,
          response: null,
        })
        .eq('claim_key', key);
      if (!up2) {
        memory.claims.set(key, { ...winner, status: 'claimed' });
        return { acquired: true, claim: { ...winner, status: 'claimed' } };
      }
      return { acquired: false, reason: 'duplicate', existing: winner };
    }
    // No winner row — treat insert error as non-fatal acquire via memory.
    return { acquired: true, claim: row };
  } catch (err) {
    if (!/relation .* does not exist|Could not find the table/i.test(err.message || '')) {
      console.warn('[supabase] tryAcquireSendClaim failed (memory only):', err.message);
    }
    // Memory already holds the claim.
    return { acquired: true, claim: row, degraded: true };
  }
}

export async function completeSendClaim(
  claimKey,
  { success, messageId = null, response = null } = {}
) {
  const key = String(claimKey || '').trim();
  if (!key) return;
  const status = success ? 'sent' : 'failed';
  const updated_at = new Date().toISOString();
  const prev = memory.claims.get(key) || { claim_key: key };
  const next = {
    ...prev,
    status,
    message_id: messageId != null ? String(messageId) : prev.message_id || null,
    response: response != null ? String(response).slice(0, 2000) : prev.response || null,
    updated_at,
  };
  // On failure, drop memory claim so retries can re-acquire quickly.
  if (success) memory.claims.set(key, next);
  else memory.claims.delete(key);

  if (!client) return;
  try {
    if (success) {
      await client.from('send_claims').upsert(
        {
          claim_key: key,
          kind: next.kind || 'confirm',
          shopify_order_id: next.shopify_order_id || null,
          webhook_id: next.webhook_id || null,
          template_id: next.template_id || null,
          status: 'sent',
          message_id: next.message_id,
          response: next.response,
          updated_at,
        },
        { onConflict: 'claim_key' }
      );
    } else {
      await client
        .from('send_claims')
        .update({
          status: 'failed',
          response: next.response,
          updated_at,
        })
        .eq('claim_key', key);
    }
  } catch (err) {
    if (!/relation .* does not exist|Could not find the table/i.test(err.message || '')) {
      console.warn('[supabase] completeSendClaim failed:', err.message);
    }
  }
}

// Phone digit variants so "2010…", "010…", "+20 10…" all match.
export function phoneDigitVariants(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return [];
  const out = new Set([d]);
  if (d.startsWith('20') && d.length >= 12) {
    out.add(d.slice(2));
    out.add('0' + d.slice(2));
  }
  if (d.startsWith('0') && d.length >= 10) {
    out.add('20' + d.slice(1));
    out.add(d.slice(1));
  }
  if (!d.startsWith('20') && !d.startsWith('0') && d.length >= 9) {
    out.add('20' + d);
    out.add('0' + d);
  }
  return [...out];
}

function phoneMatches(stored, candidateVariants) {
  const s = String(stored || '').replace(/\D/g, '');
  if (!s) return false;
  if (candidateVariants.includes(s)) return true;
  // Suffix match (last 9–10 digits) covers formatting differences.
  return candidateVariants.some(
    (v) =>
      (v.length >= 9 && s.endsWith(v.slice(-9))) ||
      (s.length >= 9 && v.endsWith(s.slice(-9)))
  );
}

// ------------------------------------------------------------
//  findRecentOrderByPhone(phone) -> shopify_order_id | null
//  Correlates an inbound WhatsApp button click (from a phone) to
//  the most recent order we sent that phone.
// ------------------------------------------------------------
export async function findRecentOrderByPhone(phone) {
  const variants = phoneDigitVariants(phone);
  if (!variants.length) return null;

  // 1) In-memory logs (always, including when Supabase is up).
  const memHit = memory.logs.find(
    (l) =>
      l.shopify_order_id &&
      phoneMatches(l.recipient_phone, variants) &&
      // Prefer real Shopify numeric ids
      /^\d+$/.test(String(l.shopify_order_id))
  );
  if (memHit) return String(memHit.shopify_order_id);

  if (!client) return null;

  try {
    // 2) Pull recent logs and match phone flexibly (exact eq is too brittle).
    const { data, error } = await client
      .from('message_log')
      .select('shopify_order_id, recipient_phone, created_at, success')
      .not('shopify_order_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    for (const row of data || []) {
      if (!phoneMatches(row.recipient_phone, variants)) continue;
      const oid = String(row.shopify_order_id || '');
      if (/^\d+$/.test(oid)) return oid;
    }
    return null;
  } catch (err) {
    console.warn('[supabase] findRecentOrderByPhone failed:', err.message);
    const hit = memory.logs.find(
      (l) => l.shopify_order_id && phoneMatches(l.recipient_phone, variants)
    );
    return hit ? String(hit.shopify_order_id) : null;
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
  confirmClaimKey,
  webhookClaimKey,
  inboundClaimKey,
  inquiryClaimKey,
  tryAcquireSendClaim,
  completeSendClaim,
  findRecentOrderByPhone,
  getShopifyAuth,
  saveShopifyAuth,
};
