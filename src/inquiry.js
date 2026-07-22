function cleanDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function extractInboundLabel(message) {
  if (!message || typeof message !== 'object') return '';
  const button = message.button;
  const reply = message.interactive?.button_reply;
  const text = message.text?.body;

  if (button) return String(button.text || button.payload || '').trim();
  if (reply) return String(reply.title || reply.id || '').trim();
  if (message.type === 'text' && text) return String(text).trim();
  return '';
}

export function repliedToMessageId(message) {
  return String(message?.context?.id || '').trim();
}

export async function resolveInboundOrderReference(message, lookups) {
  const replyMessageId = repliedToMessageId(message);
  if (replyMessageId) {
    const orderId = await lookups.findByReplyMessageId(replyMessageId);
    return { orderId, replyMessageId, source: 'reply_message' };
  }

  const phone = cleanDigits(message?.from);
  const orderId = phone ? await lookups.findUnambiguousByPhone(phone) : null;
  return { orderId, replyMessageId: '', source: 'unambiguous_phone' };
}

export function inquiryCaption(inquiryItem, index, total) {
  const quantity = inquiryItem.quantity ?? inquiryItem.qty ?? 1;
  const parts = [`${quantity}x ${inquiryItem.title}`];
  if (inquiryItem.size) parts.push(`\u0627\u0644\u0645\u0642\u0627\u0633 : ${inquiryItem.size}`);
  if (inquiryItem.color) parts.push(`\u0627\u0644\u0644\u0648\u0646 : ${inquiryItem.color}`);
  for (const option of inquiryItem.options || []) {
    if (!option?.value) continue;
    if ([inquiryItem.size, inquiryItem.color].includes(option.value)) continue;
    parts.push(`${option.name || '\u0627\u0644\u062e\u064a\u0627\u0631'} : ${option.value}`);
  }
  if (parts.length === 1 && inquiryItem.variantTitle) {
    parts.push(`\u0627\u0644\u062e\u064a\u0627\u0631 : ${inquiryItem.variantTitle}`);
  }
  return `(${index + 1}/${total}) ${parts.join(' - ')}`;
}

export function inquiryItemIdentity(inquiryItem, index) {
  if (inquiryItem.lineItemId) return String(inquiryItem.lineItemId);
  return [inquiryItem.productId, inquiryItem.variantId, index + 1]
    .map((part) => String(part || 'none'))
    .join(':');
}

async function outboundInquiryMessage(context, inquiryItem, caption) {
  const imageResult = await context.sendImage({
    to: context.recipientPhone,
    imageUrl: inquiryItem.imageUrl,
    caption,
  });
  return { ...imageResult, kind: 'image', imageUrl: inquiryItem.imageUrl };
}

function inquiryLogRecord(context, inquiryItem, index, total, sendResult) {
  return {
    shopify_order_id: context.orderId,
    order_number: context.orderNumber,
    recipient_phone: context.recipientPhone,
    template_id: null,
    variables: {
      action: 'inquiry_item',
      requestId: context.requestId,
      replyToMessageId: context.replyToMessageId || null,
      index: index + 1,
      total,
      lineItemId: inquiryItem.lineItemId,
      productId: inquiryItem.productId,
      variantId: inquiryItem.variantId,
      title: inquiryItem.title,
      variantTitle: inquiryItem.variantTitle,
      options: inquiryItem.options,
      quantity: inquiryItem.quantity,
      size: inquiryItem.size,
      color: inquiryItem.color,
      imageUrl: sendResult.imageUrl || null,
      imageId: inquiryItem.imageId || null,
      imageMatch: inquiryItem.imageMatch,
      providerMessageId: sendResult.messageId || null,
    },
    success: Boolean(sendResult.success),
    response:
      `[inbound] inquiry item ${index + 1}/${total} ${sendResult.kind} ` +
      `HTTP ${sendResult.httpStatus || 0} msg ${sendResult.messageId || '-'} :: ` +
      String(sendResult.raw || '').slice(0, 500),
  };
}

export async function sendInquiryItem(context, inquiryItem, index, total) {
  if (!inquiryItem.imageUrl) {
    return {
      success: false,
      skipped: true,
      reason: 'missing_exact_variant_image',
      identity: inquiryItemIdentity(inquiryItem, index),
    };
  }
  const identity = inquiryItemIdentity(inquiryItem, index);
  const claim = await context.acquireItemClaim(identity);
  if (!claim.acquired) {
    return { success: false, skipped: true, reason: claim.reason, identity };
  }

  const caption = inquiryCaption(inquiryItem, index, total);
  let sendResult;
  try {
    sendResult = await outboundInquiryMessage(context, inquiryItem, caption);
  } catch (error) {
    sendResult = {
      success: false,
      httpStatus: 0,
      raw: `send error: ${error.message}`,
      messageId: null,
      kind: 'image',
      imageUrl: inquiryItem.imageUrl,
    };
  }
  await context.completeItemClaim(identity, sendResult);
  await context.insertLog(
    inquiryLogRecord(context, inquiryItem, index, total, sendResult)
  );
  return { ...sendResult, identity, caption };
}

export async function sendInquiryItems(context, inquiryItems) {
  const missingImages = inquiryItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.imageUrl)
    .map(({ item, index }) => inquiryItemIdentity(item, index));
  if (missingImages.length) {
    return {
      results: [],
      sent: 0,
      imagesSent: 0,
      skipped: 0,
      preflightOk: false,
      missingImages,
    };
  }

  const results = [];
  for (let index = 0; index < inquiryItems.length; index += 1) {
    results.push(
      await sendInquiryItem(context, inquiryItems[index], index, inquiryItems.length)
    );
    if (typeof context.afterEach === 'function') await context.afterEach();
  }
  return {
    results,
    sent: results.filter((entry) => entry.success).length,
    imagesSent: results.filter(
      (entry) => entry.success && entry.kind === 'image'
    ).length,
    skipped: results.filter((entry) => entry.skipped).length,
    preflightOk: true,
    allSucceeded: results.every((entry) => entry.success),
  };
}

function orderItemIdentities(items) {
  return items.map((item, index) => ({
    lineItemId: inquiryItemIdentity(item, index),
    productId: item.productId,
    variantId: item.variantId,
  }));
}

async function recordPreflightFailure(context, items, response) {
  await context.insertLog({
    shopify_order_id: context.orderId,
    order_number: context.orderNumber,
    recipient_phone: context.recipientPhone,
    template_id: null,
    variables: {
      action: 'inquiry_preflight',
      requestId: context.requestId,
      replyToMessageId: context.replyToMessageId || null,
      affectedLineItems: orderItemIdentities(items),
    },
    success: false,
    response,
  });
}

async function sendClaimedIntro(context, itemCount) {
  const claim = await context.acquireItemClaim('intro');
  if (!claim.acquired) return;
  let result;
  try {
    result = await context.sendText({
      to: context.recipientPhone,
      text: `\u062a\u0641\u0627\u0635\u064a\u0644 \u0645\u0646\u062a\u062c\u0627\u062a \u0637\u0644\u0628\u0643 (${itemCount} \u0635\u0646\u0641) \ud83d\udc47`,
    });
  } catch (error) {
    result = { success: false, raw: error.message, messageId: null };
  }
  await context.completeItemClaim('intro', result);
}

function inquirySummaryRecord(context, itemCount, delivery) {
  return {
    shopify_order_id: context.orderId,
    order_number: context.orderNumber,
    recipient_phone: context.recipientPhone,
    template_id: null,
    variables: {
      action: 'inquiry',
      requestId: context.requestId,
      replyToMessageId: context.replyToMessageId || null,
      items: itemCount,
      sent: delivery.sent,
      imagesSent: delivery.imagesSent,
      skipped: delivery.skipped,
      button: context.buttonLabel,
    },
    success: Boolean(delivery.allSucceeded),
    response:
      `[inbound] inquiry -> sent ${delivery.sent}/${itemCount} ` +
      `exact product images; skipped=${delivery.skipped}`,
  };
}

export async function deliverInquiry(context, items) {
  if (!items.length) {
    await context.sendText({
      to: context.recipientPhone,
      text: '\u0644\u0627 \u062a\u0648\u062c\u062f \u0623\u0635\u0646\u0627\u0641 \u0641\u064a \u0647\u0630\u0627 \u0627\u0644\u0637\u0644\u0628.',
    });
    await recordPreflightFailure(context, [], 'inquiry has no line items');
    return {
      allSucceeded: false,
      sent: 0,
      imagesSent: 0,
      skipped: 0,
      reason: 'no_line_items',
    };
  }

  const missingImages = items.filter((item) => !item.imageUrl);
  if (missingImages.length) {
    await context.sendText({
      to: context.recipientPhone,
      text: '\u062a\u0639\u0630\u0651\u0631 \u062c\u0644\u0628 \u0635\u0648\u0631 \u0645\u0646\u062a\u062c\u0627\u062a \u0637\u0644\u0628\u0643 \u0628\u062f\u0642\u0629 \u062d\u0627\u0644\u064a\u064b\u0627. \u0644\u0646 \u0646\u0631\u0633\u0644 \u0635\u0648\u0631\u0629 \u0628\u062f\u064a\u0644\u0629 \u063a\u064a\u0631 \u0645\u0637\u0627\u0628\u0642\u0629 \ud83d\ude4f',
    });
    await recordPreflightFailure(
      context,
      missingImages,
      '[inbound] inquiry blocked: exact variant image missing'
    );
    return {
      allSucceeded: false,
      sent: 0,
      imagesSent: 0,
      skipped: 0,
      reason: 'missing_exact_variant_image',
    };
  }

  await sendClaimedIntro(context, items.length);
  const delivery = await sendInquiryItems(context, items);
  await context.insertLog(inquirySummaryRecord(context, items.length, delivery));
  return { ...delivery, reason: delivery.allSucceeded ? 'sent' : 'send_failed' };
}
