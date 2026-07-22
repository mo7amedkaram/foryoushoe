// ============================================================
//  src/supabase.js
//  Supabase client factory + config/log helpers.
//
//  Local development may use in-memory state when Supabase is not configured.
//  Production send claims fail closed if configured persistence is invalid or
//  unavailable; cross-instance idempotency must never silently degrade.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

const CONFIG_ROW_ID = 1; // single-row config table
const SHOPIFY_AUTH_ROW_ID = 1; // single-row shopify_auth table

function decodeJwtPayload(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function validateSupabaseConfig({ url, serviceRoleKey } = {}) {
  if (!url || !serviceRoleKey) return { valid: false, code: 'NOT_CONFIGURED' };
  let projectRef = '';
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (!hostname.endsWith('.supabase.co')) {
      return { valid: false, code: 'INVALID_PROJECT_URL' };
    }
    projectRef = hostname.split('.')[0];
  } catch {
    return { valid: false, code: 'INVALID_URL' };
  }
  const payload = decodeJwtPayload(serviceRoleKey);
  if (!payload) return { valid: false, code: 'INVALID_SERVICE_KEY' };
  if (payload.role !== 'service_role') {
    return { valid: false, code: 'KEY_IS_NOT_SERVICE_ROLE' };
  }
  if (payload.ref && projectRef && payload.ref !== projectRef) {
    return { valid: false, code: 'PROJECT_REF_MISMATCH' };
  }
  return { valid: true, code: 'OK', projectRef };
}

const supabaseConfig = validateSupabaseConfig({
  url: config.supabase.url,
  serviceRoleKey: config.supabase.serviceRoleKey,
});
let client = null;
let lastHealth = {
  checkedAt: 0,
  healthy: false,
  code: supabaseConfig.code,
  error: null,
};

if (supabaseConfig.valid) {
  try {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false },
    });
    console.log('[supabase] client configured; awaiting health probe.');
  } catch (err) {
    console.warn('[supabase] failed to create client:', err.message);
    client = null;
    lastHealth = {
      checkedAt: Date.now(),
      healthy: false,
      code: 'CLIENT_INIT_FAILED',
      error: err.message,
    };
  }
} else {
  console.warn(
    `[supabase] persistence unavailable (${supabaseConfig.code}). ` +
      'Outbound production sends will fail closed.'
  );
}

export function isSupabaseEnabled() {
  return Boolean(client);
}

export function isSupabaseConfigured() {
  return Boolean(config.supabase.enabled);
}

export function getSupabaseStatus() {
  return {
    configured: isSupabaseConfigured(),
    configValid: supabaseConfig.valid,
    configCode: supabaseConfig.code,
    healthy: Boolean(lastHealth.healthy),
    checkedAt: lastHealth.checkedAt
      ? new Date(lastHealth.checkedAt).toISOString()
      : null,
    error: lastHealth.error,
  };
}

export async function checkSupabaseHealth({ force = false } = {}) {
  if (!client) return getSupabaseStatus();
  if (!force && Date.now() - lastHealth.checkedAt < 15000) {
    return getSupabaseStatus();
  }
  try {
    const { error: configError } = await client
      .from('app_config')
      .select('id')
      .limit(1);
    if (configError) throw configError;
    const { error: claimsError } = await client
      .from('send_claims')
      .select('claim_key')
      .limit(1);
    if (claimsError) throw claimsError;
    lastHealth = { checkedAt: Date.now(), healthy: true, code: 'OK', error: null };
  } catch (error) {
    lastHealth = {
      checkedAt: Date.now(),
      healthy: false,
      code: 'QUERY_FAILED',
      error: String(error?.message || error).slice(0, 300),
    };
  }
  return getSupabaseStatus();
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
//  Fail-closed idempotency check.
// ------------------------------------------------------------
export async function hasSuccessfulLog(orderId, templateId) {
  if (!orderId) return false;
  const oid = String(orderId);
  const tid = templateId ? String(templateId) : null;

  // Always check in-process memory first. insertLog writes here even when
  // Supabase is down — without this, automated workers can resend an order.
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

  if (!client) return isSupabaseConfigured();
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
    console.warn('[supabase] hasSuccessfulLog failed closed:', err.message);
    // Memory already checked above — do NOT return a false-negative that
    // would cause a duplicate WhatsApp send.
    return true;
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

export function inquiryItemClaimKey(orderId, messageId, itemIdentity) {
  return (
    `inquiry-item:${String(orderId)}:${String(messageId || 'na')}:` +
    String(itemIdentity || 'unknown')
  );
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
 *   { acquired: false, reason: 'already_sent'|'already_failed'|
 *     'in_progress'|'persistence_unavailable', existing? }
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

  const memoryClaim = memory.claims.get(key);
  if (memoryClaim) {
    const reason =
      memoryClaim.status === 'sent'
        ? 'already_sent'
        : memoryClaim.status === 'failed'
          ? 'already_failed'
          : 'in_progress';
    return { acquired: false, reason, existing: memoryClaim };
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

  if (!client) {
    if (isSupabaseConfigured()) {
      return { acquired: false, reason: 'persistence_unavailable' };
    }
    memory.claims.set(key, row);
    return { acquired: true, claim: row, localOnly: true };
  }

  const health = await checkSupabaseHealth();
  if (!health.healthy) {
    return { acquired: false, reason: 'persistence_unavailable' };
  }

  try {
    const { error } = await client.from('send_claims').insert(row);
    if (!error) {
      memory.claims.set(key, row);
      return { acquired: true, claim: row };
    }

    const { data: winner, error: selectError } = await client
      .from('send_claims')
      .select('*')
      .eq('claim_key', key)
      .maybeSingle();
    if (selectError) throw selectError;
    if (winner) {
      memory.claims.set(key, winner);
      const reason =
        winner.status === 'sent'
          ? 'already_sent'
          : winner.status === 'failed'
            ? 'already_failed'
            : 'in_progress';
      return { acquired: false, reason, existing: winner };
    }
    throw error;
  } catch (error) {
    console.warn('[supabase] send claim failed closed:', error.message);
    return { acquired: false, reason: 'persistence_unavailable' };
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
  // A failed/uncertain send is terminal for this request. Re-acquiring it can
  // duplicate a message that Meta accepted before a timeout or process crash.
  memory.claims.set(key, next);

  if (!client) return;
  const persisted = {
    claim_key: key,
    kind: next.kind || 'confirm',
    shopify_order_id: next.shopify_order_id || null,
    webhook_id: next.webhook_id || null,
    template_id: next.template_id || null,
    status,
    message_id: next.message_id,
    response: next.response,
    updated_at,
  };

  // Retrying this idempotent database upsert is safe and preserves the
  // provider message id needed by reply/status callbacks. This is not a
  // customer-message retry; Meta's /messages endpoint is never called here.
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { error } = await client
        .from('send_claims')
        .upsert(persisted, { onConflict: 'claim_key' });
      if (!error) return;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 75));
    }
  }

  if (lastError) {
    console.warn(
      '[supabase] completeSendClaim failed after 3 persistence attempts:',
      lastError.message || lastError
    );
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
//  Inbound message -> exact order correlation
// ------------------------------------------------------------
export async function findSendClaimByMessageId(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return null;
  const outboundKinds = new Set(['confirm', 'inquiry_item', 'order_update']);
  const memoryMatch = [...memory.claims.values()].find(
    (claim) =>
      outboundKinds.has(claim.kind) && String(claim.message_id || '') === id
  );
  if (memoryMatch) return memoryMatch;
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('send_claims')
      .select('*')
      .in('kind', [...outboundKinds])
      .eq('message_id', id)
      .limit(2);
    if (error) throw error;
    const rows = data || [];
    return rows.length === 1 ? rows[0] : null;
  } catch (error) {
    console.warn('[supabase] provider-message lookup failed:', error.message);
    return null;
  }
}

export async function findOrderByReplyMessageId(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return null;

  const memoryMatches = [...memory.claims.values()]
    .filter(
      (claim) =>
        claim.kind === 'confirm' &&
        claim.status === 'sent' &&
        String(claim.message_id || '') === id &&
        /^\d+$/.test(String(claim.shopify_order_id || ''))
    )
    .map((claim) => String(claim.shopify_order_id));
  if (new Set(memoryMatches).size === 1) return memoryMatches[0];

  if (!client) return null;
  try {
    const { data, error } = await client
      .from('send_claims')
      .select('shopify_order_id')
      .eq('kind', 'confirm')
      .eq('status', 'sent')
      .eq('message_id', id)
      .limit(2);
    if (error) throw error;
    const orderIds = [
      ...new Set(
        (data || [])
          .map((row) => String(row.shopify_order_id || ''))
          .filter((orderId) => /^\d+$/.test(orderId))
      ),
    ];
    return orderIds.length === 1 ? orderIds[0] : null;
  } catch (error) {
    console.warn('[supabase] reply-message lookup failed:', error.message);
    return null;
  }
}

function matchingConfirmationOrderIds(logs, variants) {
  return [
    ...new Set(
      logs
        .filter(
          (log) =>
            log.success === true &&
            String(log.template_id || '') === String(config.meta.templateName) &&
            /^\d+$/.test(String(log.shopify_order_id || '')) &&
            phoneMatches(log.recipient_phone, variants)
        )
        .map((log) => String(log.shopify_order_id))
    ),
  ];
}

export async function findUnambiguousOrderByPhone(phone) {
  const variants = phoneDigitVariants(phone);
  if (!variants.length) return null;

  const memoryIds = matchingConfirmationOrderIds(memory.logs, variants);
  if (!client) return memoryIds.length === 1 ? memoryIds[0] : null;

  try {
    const { data, error } = await client
      .from('message_log')
      .select(
        'shopify_order_id, recipient_phone, template_id, created_at, success'
      )
      .eq('success', true)
      .eq('template_id', config.meta.templateName)
      .not('shopify_order_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    const orderIds = [
      ...new Set([
        ...memoryIds,
        ...matchingConfirmationOrderIds(data || [], variants),
      ]),
    ];
    return orderIds.length === 1 ? orderIds[0] : null;
  } catch (error) {
    console.warn('[supabase] phone correlation failed:', error.message);
    return null;
  }
}

export async function hasMessageAttempt(orderId, templateId) {
  const order = String(orderId || '');
  const template = String(templateId || '');
  if (!order) return false;

  if (
    memory.logs.some(
      (log) =>
        String(log.shopify_order_id || '') === order &&
        (!template || String(log.template_id || '') === template)
    )
  ) {
    return true;
  }
  if (template && memory.claims.has(confirmClaimKey(order, template))) return true;
  if (!client) return isSupabaseConfigured();

  try {
    if (template) {
      const claim = await getSendClaim(confirmClaimKey(order, template));
      if (claim) return true;
    }
    let query = client
      .from('message_log')
      .select('id', { count: 'exact', head: true })
      .eq('shopify_order_id', order);
    if (template) query = query.eq('template_id', template);
    const { count, error } = await query;
    if (error) throw error;
    return (count || 0) > 0;
  } catch (error) {
    console.warn('[supabase] attempt lookup failed closed:', error.message);
    return true;
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
  isSupabaseConfigured,
  getSupabaseStatus,
  checkSupabaseHealth,
  validateSupabaseConfig,
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
  inquiryItemClaimKey,
  tryAcquireSendClaim,
  completeSendClaim,
  findUnambiguousOrderByPhone,
  findOrderByReplyMessageId,
  findSendClaimByMessageId,
  hasMessageAttempt,
  getShopifyAuth,
  saveShopifyAuth,
};
