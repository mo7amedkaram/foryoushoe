// ============================================================
//  scripts/rename-tags.mjs
//
//  One-time backfill: normalise every Shopify order that has had a
//  successful WhatsApp send (per Supabase message_log) to the new
//  EMOJI status tags, removing the old plain-text ones.
//
//   plain "WhatsApp Confirmed"    -> "✅ WhatsApp Confirmed"
//   plain "Pending Confirmation"  -> "⏳ Pending Confirmation"
//   plain "WhatsApp Cancelled"    -> "❌ WhatsApp Cancelled"
//
//  Status precedence: confirmed > cancelled (tag or cancelled_at)
//  > pending. An order that was sent but somehow has no status tag
//  is set to Pending. Idempotent & safe to re-run; throttled to
//  respect Shopify's API rate limit. Reads everything from .env —
//  NO secrets in this file.
//
//  Run from the project root:  node scripts/rename-tags.mjs
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config.js';
import {
  fetchOrderById,
  setOrderStatusTags,
  statusFromTags,
  CONFIRM_TAG,
  PENDING_TAG,
  CANCEL_TAG,
  ALL_STATUS_ALIASES,
} from '../src/shopifyOAuth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALIAS_LC = ALL_STATUS_ALIASES.map((s) => s.toLowerCase());

async function distinctSentOrderIds() {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env');
  }
  const sb = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    { auth: { persistSession: false } }
  );
  const ids = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('message_log')
      .select('shopify_order_id')
      .eq('success', true)
      .range(from, from + PAGE - 1);
    if (error) throw new Error('Supabase query failed: ' + error.message);
    for (const r of data || []) {
      const id = String(r.shopify_order_id || '');
      if (/^\d+$/.test(id)) ids.add(id);
    }
    if (!data || data.length < PAGE) break;
  }
  return [...ids];
}

(async () => {
  const ids = await distinctSentOrderIds();
  console.log(`Orders with a successful send: ${ids.length}`);

  let conf = 0,
    canc = 0,
    pend = 0,
    unchanged = 0,
    notfound = 0,
    failed = 0,
    i = 0;

  for (const id of ids) {
    i++;
    try {
      const got = await fetchOrderById(id);
      if (!got.ok || !got.order) {
        notfound++;
        await sleep(300);
        continue;
      }
      const o = got.order;
      const cur = String(o.tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      // Determine the canonical status (sent but untagged => pending).
      let st = statusFromTags(cur);
      if (st === 'none') st = o.cancelled_at ? 'cancelled' : 'pending';
      else if (st !== 'confirmed' && o.cancelled_at) st = 'cancelled';
      const canon =
        st === 'confirmed' ? CONFIRM_TAG : st === 'cancelled' ? CANCEL_TAG : PENDING_TAG;

      // Skip if already exactly the canonical emoji tag and no
      // legacy/other status tag is present.
      const hasCanon = cur.some((t) => t === canon);
      const hasOther = cur.some(
        (t) => ALIAS_LC.includes(t.toLowerCase()) && t !== canon
      );
      if (hasCanon && !hasOther) {
        unchanged++;
        await sleep(250);
        continue;
      }

      const res = await setOrderStatusTags(id, {
        add: [canon],
        remove: ALL_STATUS_ALIASES,
      });
      if (res.ok) {
        if (st === 'confirmed') conf++;
        else if (st === 'cancelled') canc++;
        else pend++;
      } else {
        failed++;
        console.warn(`  ! ${id}: ${res.error || ''} ${res.message || ''}`);
      }
      await sleep(550);
    } catch (e) {
      failed++;
      console.warn(`  ! ${id}: ${e.message}`);
      await sleep(400);
    }
    if (i % 25 === 0) {
      console.log(
        `  ...${i}/${ids.length}  ✅${conf} ❌${canc} ⏳${pend}  unchanged ${unchanged}  notfound ${notfound}  failed ${failed}`
      );
    }
  }

  console.log(`\nDONE ${i}/${ids.length}`);
  console.log(`✅ confirmed -> emoji : ${conf}`);
  console.log(`❌ cancelled -> emoji : ${canc}`);
  console.log(`⏳ pending   -> emoji : ${pend}`);
  console.log(`already canonical     : ${unchanged}`);
  console.log(`not found (404)       : ${notfound}`);
  console.log(`failed                : ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
