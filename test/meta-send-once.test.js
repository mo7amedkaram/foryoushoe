import test from 'node:test';
import assert from 'node:assert/strict';

test('an image delivery failure never triggers a second /messages request', async () => {
  process.env.META_ACCESS_TOKEN = 'test-token';
  process.env.META_PHONE_NUMBER_ID = 'test-phone-id';
  process.env.META_API_VERSION = 'v22.0';
  const { sendImageMessage } = await import('../src/meta.js');

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/messages')) {
      return {
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { code: 2, message: 'timeout' } }),
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => 'not found',
    };
  };

  try {
    const result = await sendImageMessage({
      to: '201000000001',
      imageUrl: 'https://images.example/variant-black.jpg',
      caption: '1x Runner - Black',
    });
    assert.equal(result.success, false);
    assert.equal(
      calls.filter((call) => call.url.endsWith('/messages')).length,
      1
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a template failure is terminal and never substitutes a configured logo', async () => {
  process.env.META_ACCESS_TOKEN = 'test-token';
  process.env.META_PHONE_NUMBER_ID = 'test-phone-id';
  process.env.META_API_VERSION = 'v22.0';
  process.env.META_FALLBACK_IMAGE = 'https://images.example/brand-logo.png';
  const { sendTemplateMessage } = await import('../src/meta.js');

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      body: options.body ? String(options.body) : '',
    });
    if (String(url).endsWith('/messages')) {
      return {
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { code: 2, message: 'timeout' } }),
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => 'not found',
    };
  };

  try {
    const result = await sendTemplateMessage({
      to: '201000000001',
      templateName: 'order_confirm_iamge',
      orderedValues: ['Order 1001'],
      headerImageUrl: 'https://images.example/variant-black.jpg',
      forceImageHeader: true,
    });
    const messageCalls = calls.filter((call) => call.url.endsWith('/messages'));

    assert.equal(result.success, false);
    assert.equal(messageCalls.length, 1);
    assert.match(messageCalls[0].body, /variant-black/);
    assert.doesNotMatch(messageCalls[0].body, /brand-logo/);
    assert.equal(calls.some((call) => call.url.includes('brand-logo')), false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.META_FALLBACK_IMAGE;
  }
});
