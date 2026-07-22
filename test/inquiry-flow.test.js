import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveInboundOrderReference,
  deliverInquiry,
  sendInquiryItems,
} from '../src/inquiry.js';

test('reply context resolves the exact sent confirmation without phone fallback', async () => {
  let phoneLookups = 0;
  const resolved = await resolveInboundOrderReference(
    { from: '201000000001', context: { id: 'wamid.confirm-A' } },
    {
      findByReplyMessageId: async (id) =>
        id === 'wamid.confirm-A' ? 'order-A' : null,
      findUnambiguousByPhone: async () => {
        phoneLookups += 1;
        return 'wrong-order';
      },
    }
  );

  assert.deepEqual(resolved, {
    orderId: 'order-A',
    replyMessageId: 'wamid.confirm-A',
    source: 'reply_message',
  });
  assert.equal(phoneLookups, 0);
});

test('unknown reply context fails closed instead of selecting a recent phone order', async () => {
  let phoneLookups = 0;
  const resolved = await resolveInboundOrderReference(
    { from: '201000000001', context: { id: 'wamid.unknown' } },
    {
      findByReplyMessageId: async () => null,
      findUnambiguousByPhone: async () => {
        phoneLookups += 1;
        return 'old-order';
      },
    }
  );

  assert.equal(resolved.orderId, null);
  assert.equal(phoneLookups, 0);
});

function deliveryHarness({ recipientPhone, orderId, blocked = new Set() }) {
  const images = [];
  const texts = [];
  const logs = [];
  const completed = [];
  return {
    images,
    texts,
    logs,
    completed,
    context: {
      recipientPhone,
      orderId,
      orderNumber: `#${orderId}`,
      requestId: `request-${orderId}`,
      replyToMessageId: `confirm-${orderId}`,
      acquireItemClaim: async (identity) =>
        blocked.has(identity)
          ? { acquired: false, reason: 'already_sent' }
          : { acquired: true },
      completeItemClaim: async (identity, result) => {
        completed.push({ identity, success: result.success });
        blocked.add(identity);
      },
      insertLog: async (row) => logs.push(row),
      sendImage: async (payload) => {
        images.push(payload);
        return {
          success: true,
          httpStatus: 200,
          raw: 'accepted',
          messageId: `message-${images.length}`,
        };
      },
      sendText: async (payload) => {
        texts.push(payload);
        return {
          success: true,
          httpStatus: 200,
          raw: 'accepted',
          messageId: `text-${texts.length}`,
        };
      },
    },
  };
}

const items = [
  {
    lineItemId: 'line-black',
    productId: 'product-1',
    variantId: 'variant-black',
    quantity: 1,
    title: 'Runner',
    color: 'Black',
    size: '39',
    options: [],
    imageUrl: 'https://cdn.example/black.jpg',
    imageId: 'image-black',
    imageMatch: 'variant_image_id',
  },
  {
    lineItemId: 'line-beige',
    productId: 'product-1',
    variantId: 'variant-beige',
    quantity: 2,
    title: 'Runner',
    color: 'Beige',
    size: '38',
    options: [],
    imageUrl: 'https://cdn.example/beige.jpg',
    imageId: 'image-beige',
    imageMatch: 'variant_image_id',
  },
];

test('sends multi-variant items sequentially to one customer with matching captions', async () => {
  const harness = deliveryHarness({ recipientPhone: '201000000001', orderId: 'A' });
  const result = await sendInquiryItems(harness.context, items);

  assert.equal(result.allSucceeded, true);
  assert.deepEqual(
    harness.images.map(({ to, imageUrl }) => ({ to, imageUrl })),
    [
      { to: '201000000001', imageUrl: 'https://cdn.example/black.jpg' },
      { to: '201000000001', imageUrl: 'https://cdn.example/beige.jpg' },
    ]
  );
  assert.match(harness.images[0].caption, /Black/);
  assert.doesNotMatch(harness.images[0].caption, /Beige/);
  assert.match(harness.images[1].caption, /Beige/);
  assert.equal(harness.logs[0].shopify_order_id, 'A');
  assert.equal(harness.logs[1].variables.lineItemId, 'line-beige');
});

test('consecutive customer requests do not share recipient, order, or item state', async () => {
  const first = deliveryHarness({ recipientPhone: '201000000001', orderId: 'A' });
  const second = deliveryHarness({ recipientPhone: '201000000002', orderId: 'B' });

  await sendInquiryItems(first.context, [items[0]]);
  await sendInquiryItems(second.context, [items[1]]);

  assert.equal(first.images[0].to, '201000000001');
  assert.equal(first.images[0].imageUrl, 'https://cdn.example/black.jpg');
  assert.equal(second.images[0].to, '201000000002');
  assert.equal(second.images[0].imageUrl, 'https://cdn.example/beige.jpg');
  assert.equal(first.logs[0].shopify_order_id, 'A');
  assert.equal(second.logs[0].shopify_order_id, 'B');
});

test('a duplicate request claim sends no duplicate item messages', async () => {
  const blocked = new Set();
  const harness = deliveryHarness({
    recipientPhone: '201000000001',
    orderId: 'A',
    blocked,
  });

  await sendInquiryItems(harness.context, items);
  const second = await sendInquiryItems(harness.context, items);

  assert.equal(harness.images.length, 2);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 2);
});

test('missing exact image blocks the whole batch and sends only an explanatory text', async () => {
  const harness = deliveryHarness({ recipientPhone: '201000000001', orderId: 'A' });
  const missing = [{ ...items[0], imageUrl: '' }];
  const result = await deliverInquiry(harness.context, missing);

  assert.equal(result.reason, 'missing_exact_variant_image');
  assert.equal(harness.images.length, 0);
  assert.equal(harness.texts.length, 1);
  assert.equal(harness.logs[0].variables.action, 'inquiry_preflight');
  assert.equal(harness.completed.length, 0);
});
