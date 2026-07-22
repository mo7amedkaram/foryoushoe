// ============================================================
//  End-to-end simulation:
//   1) Idempotent confirmation (claim + double processOrder)
//   2) Product inquiry with images for phone +201029941259
// ============================================================
import { config } from '../src/config.js';
import {
  tryAcquireSendClaim,
  completeSendClaim,
  confirmClaimKey,
  webhookClaimKey,
  hasSuccessfulLog,
  insertLog,
} from '../src/supabase.js';
import {
  adminApiGet,
  enrichOrderFromShopify,
  getOrderItemsDetailed,
  fetchOrderById,
  statusFromTags,
} from '../src/shopifyOAuth.js';
import {
  sendTemplateMessage,
  sendImageMessage,
  sendTextMessage,
  toMetaSafeImageUrl,
} from '../src/meta.js';
import { resolvers, pickRecipientPhone, normalizePhone } from '../src/shopify.js';

const TEST_PHONE = '201029941259';
const results = [];
const log = (step, data) => {
  const row = { step, at: new Date().toISOString(), ...data };
  results.push(row);
  console.log(JSON.stringify(row));
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== E2E duplicate-send + inquiry image test ===');
  console.log('phone', TEST_PHONE);
  console.log('template', config.meta.templateName);
  console.log('fallback', config.meta.fallbackImage);

  // ---------- A) Claim insert-wins ----------
  const fakeOrderId = `E2E-${Date.now()}`;
  const tpl = config.meta.templateName || 'order_confirm_iamge';
  const ckey = confirmClaimKey(fakeOrderId, tpl);
  const a1 = await tryAcquireSendClaim({
    claimKey: ckey,
    kind: 'confirm',
    shopifyOrderId: fakeOrderId,
    templateId: tpl,
  });
  const a2 = await tryAcquireSendClaim({
    claimKey: ckey,
    kind: 'confirm',
    shopifyOrderId: fakeOrderId,
    templateId: tpl,
  });
  log('claim_double_acquire', {
    first: a1.acquired,
    second: a2.acquired,
    secondReason: a2.reason,
    pass: a1.acquired === true && a2.acquired === false,
  });
  await completeSendClaim(ckey, { success: true, messageId: 'wamid.e2e-test' });
  const a3 = await tryAcquireSendClaim({
    claimKey: ckey,
    kind: 'confirm',
    shopifyOrderId: fakeOrderId,
    templateId: tpl,
  });
  log('claim_after_sent', {
    acquired: a3.acquired,
    reason: a3.reason,
    pass: a3.acquired === false && a3.reason === 'already_sent',
  });

  // Webhook id duplicate
  const wh = `wh-e2e-${Date.now()}`;
  const w1 = await tryAcquireSendClaim({
    claimKey: webhookClaimKey(wh),
    kind: 'webhook',
    webhookId: wh,
  });
  const w2 = await tryAcquireSendClaim({
    claimKey: webhookClaimKey(wh),
    kind: 'webhook',
    webhookId: wh,
  });
  log('webhook_claim_double', {
    first: w1.acquired,
    second: w2.acquired,
    pass: w1.acquired && !w2.acquired,
  });
  await completeSendClaim(webhookClaimKey(wh), { success: true });

  // ---------- B) Real Shopify order → confirm once, then skip ----------
  const list = await adminApiGet(
    'orders.json?status=any&limit=15&order=created_at+desc&fields=' +
      encodeURIComponent(
        'id,name,order_number,tags,line_items,customer,phone,shipping_address,billing_address,total_price,currency,financial_status,fulfillment_status,created_at'
      )
  );
  if (!list.ok || !(list.data && list.data.orders && list.data.orders[0])) {
    log('fetch_orders', { ok: false, error: list.error || list.message });
    throw new Error('Could not fetch Shopify orders for E2E');
  }

  // Prefer an order that has line items with product_id
  const base =
    list.data.orders.find(
      (o) =>
        Array.isArray(o.line_items) &&
        o.line_items.some((li) => li && li.product_id)
    ) || list.data.orders[0];

  // Clone order for test send to TEST_PHONE without mutating Shopify.
  const order = structuredClone(base);
  // Synthetic id so we don't collide with production confirm claims / tags.
  const testOrderId = `9000${String(Date.now()).slice(-10)}`;
  order.id = testOrderId;
  order.name = `#E2E-${order.order_number || 'TEST'}`;
  order.tags = '';
  if (!order.shipping_address) order.shipping_address = {};
  order.shipping_address.phone = `+${TEST_PHONE}`;
  if (!order.customer) order.customer = {};
  order.customer.phone = `+${TEST_PHONE}`;
  order.phone = `+${TEST_PHONE}`;

  await enrichOrderFromShopify(order);
  log('order_prepared', {
    shopifySource: base.name,
    testOrderId,
    productImageUrl: order.productImageUrl || null,
    lineItems: (order.line_items || []).length,
    tagStatus: statusFromTags(order.tags),
  });

  const phone = normalizePhone(TEST_PHONE, '20');
  const claimKey = confirmClaimKey(testOrderId, tpl);

  // Acquire claim like processOrder does
  const acq = await tryAcquireSendClaim({
    claimKey,
    kind: 'confirm',
    shopifyOrderId: testOrderId,
    templateId: tpl,
  });
  if (!acq.acquired) {
    log('confirm_claim', { ok: false, reason: acq.reason });
    throw new Error('Could not acquire confirm claim for E2E order');
  }

  const CANON = [
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
  const settings = {
    store_name: config.defaults.storeName,
    default_country_code: '20',
    recipient_phone_source: 'shipping',
  };
  const orderedValues = CANON.map((name) => {
    const r = resolvers[name];
    if (!r) return '-';
    try {
      const v = r.fn(order, settings);
      return v == null || v === '' ? '-' : String(v);
    } catch {
      return '-';
    }
  });
  // Override customer name slightly so it's identifiable
  orderedValues[1] = 'E2E Test Customer';

  const headerImageUrl =
    toMetaSafeImageUrl(order.productImageUrl) ||
    toMetaSafeImageUrl(config.meta.fallbackImage) ||
    '';

  const send1 = await sendTemplateMessage({
    to: phone,
    templateName: tpl,
    languageCode: config.meta.templateLang,
    orderedValues,
    headerImageUrl,
    fallbackImageUrl: toMetaSafeImageUrl(config.meta.fallbackImage),
    forceImageHeader: true,
  });
  log('confirm_send_1', {
    success: send1.success,
    httpStatus: send1.httpStatus,
    messageId: send1.messageId || null,
    headerImageUsed: send1.headerImageUsed || null,
    raw: String(send1.raw || '').slice(0, 400),
  });

  await insertLog({
    shopify_order_id: testOrderId,
    order_number: order.name,
    recipient_phone: phone,
    template_id: tpl,
    variables: { e2e: true, action: 'confirm_send_1' },
    success: Boolean(send1.success),
    response: `[e2e] HTTP ${send1.httpStatus} :: ${send1.raw}`,
  });
  await completeSendClaim(claimKey, {
    success: Boolean(send1.success),
    messageId: send1.messageId || null,
    response: send1.raw,
  });

  // Second send attempt must be blocked by claim
  const acq2 = await tryAcquireSendClaim({
    claimKey,
    kind: 'confirm',
    shopifyOrderId: testOrderId,
    templateId: tpl,
  });
  const already = await hasSuccessfulLog(testOrderId, tpl);
  log('confirm_send_2_blocked', {
    claimAcquired: acq2.acquired,
    claimReason: acq2.reason,
    hasSuccessfulLog: already,
    pass:
      acq2.acquired === false &&
      (acq2.reason === 'already_sent' || acq2.reason === 'in_progress' || already),
  });

  // If first send failed, stop (can't test inquiry well without session)
  if (!send1.success) {
    log('abort', { reason: 'confirm template send failed — cannot open inquiry session' });
    printSummary();
    process.exit(2);
  }

  // ---------- C) Inquiry images (simulate customer session) ----------
  // Free-form images only work inside 24h window after customer messages us.
  // We cannot fully open a customer session without the user tapping WhatsApp.
  // We still verify product image resolution + Meta image send to the test number
  // after a short delay (template may not open session for free-form).
  // Prefer: send a text first (may fail outside session), then images.
  await sleep(800);

  // Use source order id for real product details if synthetic clone has same line_items
  const items = await getOrderItemsDetailed(order);
  log('inquiry_items_resolved', {
    count: items.length,
    withImage: items.filter((i) => i.imageUrl).length,
    sample: items.slice(0, 3).map((i) => ({
      title: i.title,
      size: i.size,
      color: i.color,
      imageUrl: i.imageUrl ? i.imageUrl.slice(0, 120) : null,
    })),
  });

  const intro = await sendTextMessage({
    to: phone,
    text: `تفاصيل منتجات طلبك (${items.length} صنف) 👇 [E2E]`,
  });
  log('inquiry_intro', {
    success: intro.success,
    httpStatus: intro.httpStatus,
    messageId: intro.messageId,
    raw: String(intro.raw || '').slice(0, 300),
  });

  let imagesOk = 0;
  let textsOk = 0;
  for (let i = 0; i < Math.min(items.length, 5); i++) {
    const it = items[i];
    const parts = [`${it.qty}x ${it.title}`];
    if (it.size) parts.push(`المقاس : ${it.size}`);
    if (it.color) parts.push(`اللون : ${it.color}`);
    const caption = `(${i + 1}/${items.length}) ${parts.join(' - ')} [E2E]`;
    if (it.imageUrl) {
      const r = await sendImageMessage({
        to: phone,
        imageUrl: it.imageUrl,
        caption,
      });
      log('inquiry_image', {
        index: i + 1,
        success: r.success,
        httpStatus: r.httpStatus,
        messageId: r.messageId,
        mediaId: r.mediaId || null,
        imageSource: (r.imageSource || it.imageUrl || '').slice(0, 120),
        raw: String(r.raw || '').slice(0, 250),
      });
      if (r.success) imagesOk += 1;
      await insertLog({
        shopify_order_id: testOrderId,
        order_number: order.name,
        recipient_phone: phone,
        template_id: null,
        variables: { e2e: true, action: 'inquiry_image', index: i + 1 },
        success: Boolean(r.success),
        response: `[e2e-inquiry] HTTP ${r.httpStatus} :: ${r.raw}`,
      });
    } else {
      const r = await sendTextMessage({
        to: phone,
        text: `${caption}\n(لا تتوفر صورة لهذا المنتج)`,
      });
      log('inquiry_text_fallback', {
        index: i + 1,
        success: r.success,
        messageId: r.messageId,
      });
      if (r.success) textsOk += 1;
    }
    await sleep(400);
  }

  log('inquiry_summary', {
    imagesOk,
    textsOk,
    items: items.length,
    // Free-form may fail outside 24h window; image *resolution* is the critical app fix.
    imagesResolved: items.filter((i) => i.imageUrl).length,
    passImagesResolved:
      items.length === 0 || items.every((i) => i.imageUrl) || items.some((i) => i.imageUrl),
  });

  printSummary();
  const claimPass = results.find((r) => r.step === 'claim_double_acquire')?.pass;
  const blockPass = results.find((r) => r.step === 'confirm_send_2_blocked')?.pass;
  const imgResolved = results.find((r) => r.step === 'inquiry_summary')?.imagesResolved > 0;
  if (claimPass && blockPass && send1.success && imgResolved) {
    process.exit(0);
  }
  process.exit(1);
}

function printSummary() {
  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    if (r.pass != null) console.log(`${r.step}: ${r.pass ? 'PASS' : 'FAIL'}`);
    else if (r.success != null) console.log(`${r.step}: ${r.success ? 'OK' : 'FAIL'}`);
  }
}

main().catch((err) => {
  console.error('E2E fatal:', err);
  process.exit(1);
});
