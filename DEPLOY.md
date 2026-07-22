# Deploy on Railway

This is a **long-running Node.js (Express) server** — Railway runs it as-is
(`npm start` → `node server.js`). No code changes, no serverless rewrite.

`railway.json` configures the start command + a `/api/health` health check.
Node is pinned to `22.x` (`package.json` → `engines`).

> 🔒 **Secrets never go in the repo.** `.env` is git-ignored. All secrets
> are set in **Railway → your service → Variables**. `.env.example` lists
> every variable name (no values).

---

## Option A — Deploy from GitHub (recommended)

1. Push this folder to your repo (run locally; `.env` is git-ignored so it
   is NOT included):
   ```
   git init
   git add .
   git commit -m "Shopify → WhatsApp order-confirmation bridge"
   git branch -M main
   git remote add origin https://github.com/mo7amedkaram/foryoushoe.git
   git push -u origin main
   ```
   Make the repo **private** (it still references infrastructure details).
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway auto-detects Node (Nixpacks) and uses `railway.json`.
4. Add the environment variables (next section), then **Deploy**.

## Option B — Deploy from local with Railway CLI (no GitHub, safest)

```
npm i -g @railway/cli
railway login
railway init           # create/link a project
railway up             # deploys the current folder
railway variables set KEY=VALUE   # for each variable below
```

---

## Environment variables (set ALL of these in Railway → Variables)

Copy each value from your local `.env` into Railway. Do **not** commit `.env`.

**Shopify**
- `SHOP_DOMAIN`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_ADMIN_TOKEN` (optional; leave empty to use client-credentials)

**Provider / Meta WhatsApp Cloud API**
- `MESSAGE_PROVIDER` = `meta`
- `META_ACCESS_TOKEN` — use a **System User** permanent token (or long-lived).
  Short-lived user tokens expire and stop ALL sends until you update Railway.
- `META_WABA_ID`
- `META_PHONE_NUMBER_ID`
- `META_API_VERSION` = `v22.0`
- `META_TEMPLATE_NAME` = `order_confirm_iamge`
- `META_TEMPLATE_LANG` = `en` (auto-corrected from the live template)
- `META_FALLBACK_IMAGE` — **required for reliability**. Public HTTPS JPEG/PNG
  (store logo is ideal). Used when product image resolution fails so Meta
  never gets error 132012 (`expected IMAGE, received UNKNOWN`).
- `META_WEBHOOK_VERIFY_TOKEN` (any string; used in the Meta dashboard)
- `META_APP_SECRET` — ⚠️ must be the App Secret of the Meta app that is
  **subscribed to the WABA** (App ID `2029610401309541`), NOT a different
  app. The inbound webhook signature is verified with this; a wrong app's
  secret makes every real Meta webhook get rejected.

**Auto-send / token reliability (defaults are fine)**
- `ORDER_CONFIRM_CRON_ENABLED` = `true` — catch-up for missed webhooks
- `ORDER_CONFIRM_CRON_INTERVAL_MS` = `120000`
- `SHOPIFY_TOKEN_KEEPALIVE_MS` = `1800000` — auto-refresh Shopify
  client-credentials (~24h tokens) so product images keep resolving.
  You should **not** need to click “Generate token” manually anymore.

**Admin protection**
- `ADMIN_UI_TOKEN` (already generated; the UI prompts for it once)

**Phone**
- `DEFAULT_COUNTRY_CODE` = `20`

**Supabase**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`

**joud.chat (only if `MESSAGE_PROVIDER=joud`)**
- `JOUD_API_TOKEN`, `JOUD_BASE_URL`, `JOUD_PHONE_NUMBER_ID`

`PORT` is injected by Railway automatically — do **not** set it.

---

## After deploy

Railway gives a public HTTPS domain, e.g. `https://foryoushoe.up.railway.app`.

1. **Health check:** open `https://<domain>/api/health` → `{"ok":true,...}`.

2. **Meta WhatsApp webhook** — Meta App (`2029610401309541`) →
   **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://<domain>/webhooks/whatsapp`
   - Verify token: the value you set for `META_WEBHOOK_VERIFY_TOKEN`
   - **Subscribe to the `messages` field**
   - ⚠️ This replaces the current callback (joud.chat) — that app has ONE
     callback. After this, button taps (تأكيد / استفسار) reach this server.

3. **Shopify order webhook** — Shopify admin → Settings → Notifications →
   Webhooks (or via Admin API): topic `orders/create` →
   `https://<domain>/webhooks/shopify/orders-create` (HMAC-verified with
   `SHOPIFY_API_SECRET`).

4. Open `https://<domain>/`. Use **Overview** to load the latest order,
   **Orders** to send confirmations, **Activity** to inspect failures, and
   **Settings** for Shopify credentials, mappings, and test sends. Protected
   actions prompt for `ADMIN_UI_TOKEN`, which is stored in that browser.

## Verify the full flow
- Place (or use the latest) Shopify order → confirmation template arrives
  with the product image header + size/color in the items line.
- Tap **«تأكيد الأوردر»** → the order gets tagged `WhatsApp Confirmed` in
  Shopify + a confirmation reply.
- Tap **«أحتاج الي استفسار»** → images + details of all products are sent.
