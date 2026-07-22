// ============================================================
//  src/config.js
//  Loads environment variables and exposes a single config object.
// ============================================================
import dotenv from 'dotenv';

dotenv.config();

function bool(v) {
  return String(v).toLowerCase() === 'true';
}

// Derive a friendly store name from the *.myshopify.com domain.
// e.g. "for-you-shoe-6129.myshopify.com" -> "for-you-shoe-6129"
function deriveStoreName(domain) {
  if (!domain) return 'My Store';
  return String(domain).replace(/\.myshopify\.com$/i, '').trim() || 'My Store';
}

const SHOP_DOMAIN = process.env.SHOP_DOMAIN || '';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  shopify: {
    shopDomain: SHOP_DOMAIN,
    apiKey: process.env.SHOPIFY_API_KEY || '',
    apiSecret: process.env.SHOPIFY_API_SECRET || '',
    // Optional STATIC Admin API access token (e.g. shpat_... from a
    // store custom app, or an OAuth offline token). When set it takes
    // priority over the client-credentials grant for ALL Admin API
    // calls — use this to grant read_products (product images).
    adminToken: process.env.SHOPIFY_ADMIN_TOKEN || '',
  },

  // Security gates (enforced only when the value is set, so local
  // dev keeps working until you harden for production).
  security: {
    // Meta App Secret — verifies X-Hub-Signature-256 on the public
    // WhatsApp webhook so forged button taps can't drive Shopify writes.
    metaAppSecret: process.env.META_APP_SECRET || '',
    // Shared secret required on admin/mutation API routes when set.
    adminUiToken: process.env.ADMIN_UI_TOKEN || '',
  },

  joud: {
    apiToken: process.env.JOUD_API_TOKEN || '',
    baseUrl: (process.env.JOUD_BASE_URL || 'https://joud.chat/api/v1').replace(/\/+$/, ''),
    phoneNumberId: process.env.JOUD_PHONE_NUMBER_ID || '1115965254927153',
  },

  // Direct Meta WhatsApp Cloud API (bypasses joud.chat for sending).
  meta: {
    accessToken: process.env.META_ACCESS_TOKEN || '',
    wabaId: process.env.META_WABA_ID || '',
    phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
    apiVersion: process.env.META_API_VERSION || 'v22.0',
    templateLang: process.env.META_TEMPLATE_LANG || 'en',
    // Active template sent to customers. order_confirm_iamge has an
    // IMAGE header (product photo) + 11 body params.
    templateName: process.env.META_TEMPLATE_NAME || 'order_confirm_iamge',
    // Fulfilled-order tracking update template. This template is sent
    // separately from the order confirmation template.
    orderUpdateTemplateName:
      process.env.META_ORDER_UPDATE_TEMPLATE_NAME || 'order_update',
    orderUpdateButtonIndex: process.env.META_ORDER_UPDATE_BUTTON_INDEX || '0',
    // Optional fallback header image if a product has none.
    fallbackImage: process.env.META_FALLBACK_IMAGE || '',
  },

  orderUpdates: {
    cronEnabled: process.env.ORDER_UPDATE_CRON_ENABLED !== 'false',
    cronIntervalMs: Math.max(
      parseInt(process.env.ORDER_UPDATE_CRON_INTERVAL_MS || '60000', 10),
      15000
    ),
    batchLimit: Math.min(
      Math.max(parseInt(process.env.ORDER_UPDATE_CRON_BATCH_LIMIT || '50', 10), 1),
      250
    ),
  },

  // Catch-up for NEW order confirmations when the Shopify webhook is
  // missed, delayed, or fails. Scans recent open orders and sends the
  // confirmation template for any that do not yet have a successful
  // message_log row. Idempotent via hasSuccessfulLog.
  orderConfirm: {
    cronEnabled: process.env.ORDER_CONFIRM_CRON_ENABLED !== 'false',
    cronIntervalMs: Math.max(
      parseInt(process.env.ORDER_CONFIRM_CRON_INTERVAL_MS || '120000', 10),
      30000
    ),
    batchLimit: Math.min(
      Math.max(parseInt(process.env.ORDER_CONFIRM_CRON_BATCH_LIMIT || '25', 10), 1),
      100
    ),
    // Only consider orders created within this lookback window.
    lookbackHours: Math.min(
      Math.max(parseInt(process.env.ORDER_CONFIRM_LOOKBACK_HOURS || '48', 10), 1),
      168
    ),
  },

  // Proactively refresh Shopify client-credentials before they expire.
  shopifyTokenKeepaliveMs: Math.max(
    parseInt(process.env.SHOPIFY_TOKEN_KEEPALIVE_MS || '1800000', 10), // 30 min
    60000
  ),

  // Which provider sends the WhatsApp message: 'meta' (direct) | 'joud'.
  messageProvider: (process.env.MESSAGE_PROVIDER || 'meta').toLowerCase(),

  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    // Considered "configured" only when both url + service role key exist.
    get enabled() {
      return Boolean(this.url && this.serviceRoleKey);
    },
  },

  // Default values for the editable settings (overridable via the UI).
  defaults: {
    storeName: deriveStoreName(SHOP_DOMAIN),
    defaultCountryCode: (process.env.DEFAULT_COUNTRY_CODE || '20').replace(/\D/g, '') || '20',
    // Where to read the recipient phone from. This store's orders carry
    // the WhatsApp number in the SHIPPING address, so 'shipping' is the
    // correct default here. ('auto' | 'customer' | 'shipping' | 'billing')
    recipientPhoneSource: 'shipping',
  },

  debug: bool(process.env.DEBUG),
};

export default config;
