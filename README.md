# Shopify → joud.chat WhatsApp Bridge

A single-page Node.js (Express) + Supabase app that receives Shopify
`orders/create` webhooks, resolves the order fields into a joud.chat
WhatsApp template's variables, and sends the WhatsApp message to the
customer. Configuration, the variable mapping, and a send log are
stored in Supabase (with an in-memory fallback if Supabase is not
configured).

> ملاحظات بالعربية مختصرة موجودة بعد كل قسم.

---

## 1. Requirements

- Node.js v22+ (uses the built-in global `fetch` and `crypto`)
- A Supabase project (optional but recommended)
- A public URL for the Shopify webhook (tunnel or deploy)

---

## 2. Install

```powershell
cd D:\Data\shopify-whatsapp
npm install
```

Fill in `.env` (already created with the provided real credentials).
Use `.env.example` as the template. The Supabase keys are intentionally
blank — the app still boots and the UI still works without them
(degraded / in-memory mode).

**عربي:** ثبّت الحزم بـ `npm install`، ثم افتح ملف `.env` واملأ مفاتيح
Supabase (اختياري). البرنامج يعمل حتى بدونها لكن بدون حفظ دائم.

---

## 3. Supabase setup (recommended)

1. Create a project at <https://supabase.com>.
2. Open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and **Run**. This
   creates `app_config` and `message_log`.
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** secret → `SUPABASE_SERVICE_ROLE_KEY`
   - **anon public** key → `SUPABASE_ANON_KEY`
4. Paste them into `.env` and restart the app.

> The server uses the `service_role` key (server-side only). RLS is
> enabled with no public policies, so the `anon` key cannot read/write
> the tables — keep `service_role` secret.

**عربي:** أنشئ مشروع Supabase، شغّل ملف `supabase/schema.sql` داخل
محرر SQL، ثم انسخ المفاتيح من Project Settings → API وضعها في `.env`.

---

## 4. Run

```powershell
npm start
```

Open <http://localhost:3000>. Then:

1. **Settings** – set `phone_number_id`, store name, default country
   code (e.g. `20` for Egypt), recipient phone source → Save.
2. **Templates** – click *Load templates* (fetched live from
   joud.chat), pick a template. Its body and detected variables show.
3. **Mapping** – for each template variable, choose a Shopify field
   resolver or "Static text" → Save.
4. **Test send** – enter your WhatsApp number → *Send test*. A sample
   order runs through the exact same pipeline as a real webhook.
5. **Logs** – recent sends with status and the raw joud.chat response.

**عربي:** شغّل `npm start`، افتح الصفحة، احفظ الإعدادات، حمّل القوالب،
اربط المتغيرات، ثم جرّب الإرسال وراقب السجل.

---

## 5. Expose the server publicly

Shopify must reach your webhook over HTTPS. For local testing use a
tunnel; for production deploy the app (Render, Railway, a VPS, etc.).

**Cloudflare Tunnel (quick, free):**

```powershell
# install cloudflared, then:
cloudflared tunnel --url http://localhost:3000
```

**ngrok:**

```powershell
ngrok http 3000
```

Either prints a public HTTPS URL, e.g.
`https://abcd-1234.trycloudflare.com`. Your webhook endpoint is:

```
https://YOUR-PUBLIC-URL/webhooks/shopify/orders-create
```

---

## 6. Register the Shopify webhook (topic: `orders/create`)

You need the public URL from step 5. There are two ways.

### Option A — Shopify Admin UI (simplest, recommended)

1. Shopify Admin → **Settings** (bottom-left).
2. Click **Notifications**.
3. Scroll to the **Webhooks** section → **Create webhook**.
4. **Event:** `Order creation`
5. **Format:** `JSON`
6. **URL:** `https://YOUR-PUBLIC-URL/webhooks/shopify/orders-create`
7. **Webhook API version:** latest stable.
8. **Save.**

Shopify shows a signing secret for webhooks created here. **Note:**
this app verifies the HMAC using `SHOPIFY_API_SECRET` (your custom
app's shared secret). If you create the webhook from the Admin UI
*Notifications* page, Shopify signs with a per-store webhook signing
key, **not** the app secret. The most reliable approach for this app
is **Option B** (create the webhook through a custom app, so it is
signed with that app's secret which is already in `.env`).

> If you must use the Admin UI webhook, replace `SHOPIFY_API_SECRET`
> in `.env` with the signing secret Shopify displays for that webhook,
> then restart.

### Option B — Custom app + Admin API (signed with the app secret)

The provided `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` are **custom app**
credentials. To register a webhook via the Admin API you also need an
**Admin API access token** (`shpat_...`) for that custom app:

1. Shopify Admin → **Settings → Apps and sales channels →
   Develop apps**.
2. Open (or create) your custom app.
3. **Configuration → Admin API integration**: grant the
   `write_orders` / `read_orders` scopes (and webhook scopes).
4. **API credentials → Install app**, then copy the
   **Admin API access token** (`shpat_...`).

Register the webhook (PowerShell):

```powershell
$store = "for-you-shoe-6129.myshopify.com"
$token = "shpat_xxx_your_admin_api_access_token"
$publicUrl = "https://YOUR-PUBLIC-URL/webhooks/shopify/orders-create"
$apiVersion = "2024-10"

$body = @{
  webhook = @{
    topic   = "orders/create"
    address = $publicUrl
    format  = "json"
  }
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "https://$store/admin/api/$apiVersion/webhooks.json" `
  -Headers @{ "X-Shopify-Access-Token" = $token; "Content-Type" = "application/json" } `
  -Body $body
```

Equivalent `curl`:

```bash
curl -X POST \
  "https://for-you-shoe-6129.myshopify.com/admin/api/2024-10/webhooks.json" \
  -H "X-Shopify-Access-Token: shpat_xxx_your_admin_api_access_token" \
  -H "Content-Type: application/json" \
  -d '{"webhook":{"topic":"orders/create","address":"https://YOUR-PUBLIC-URL/webhooks/shopify/orders-create","format":"json"}}'
```

Webhooks created under a custom app are signed with that app's shared
secret, which matches `SHOPIFY_API_SECRET` in `.env` → HMAC
verification works out of the box.

**عربي:** سجّل الـ webhook من لوحة شوبيفاي (الأسهل) أو عبر تطبيق مخصص
باستخدام Admin API. التطبيق يتحقق من HMAC باستخدام
`SHOPIFY_API_SECRET`. إذا أنشأت الـ webhook من صفحة Notifications ضع
سرّ التوقيع الذي يعرضه شوبيفاي مكان `SHOPIFY_API_SECRET`.

---

## 7. Shopify OAuth setup (REQUIRED to fetch real orders)

The Shopify `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` in `.env` are the
**client_id / client_secret of an app you created in the Shopify
Partner / Developer dashboard** — *not* an Admin custom-app token.
In 2026 Shopify removed the direct "Admin API access token" tab for
Partner-created apps, so the app must obtain a token through the
**OAuth authorization-code grant**. This app implements the **offline
(non-expiring) token** flow.

### 7.1 What you must do in the Shopify Partner / Developer dashboard

1. **Run a public HTTPS tunnel** to your local server (Shopify only
   redirects to HTTPS URLs):

   ```powershell
   cloudflared tunnel --url http://localhost:3000
   # or
   ngrok http 3000
   ```

   This prints a public URL such as
   `https://abcd-1234.trycloudflare.com`. Call it `<PUBLIC_TUNNEL>`.
   It changes every time you restart the tunnel — keep the dashboard
   in sync (next step).

2. Open <https://partners.shopify.com> → **Apps** → your app →
   **Configuration** (or **App setup**) and set the **URLs**:
   - **App URL:** `https://<PUBLIC_TUNNEL>`
   - **Allowed redirection URL(s):** add **exactly**
     `https://<PUBLIC_TUNNEL>/auth/callback`

   > The redirect URL must match **character-for-character** what the
   > app sends. This app derives it from the incoming request host
   > (it honors `X-Forwarded-Host`/`-Proto` so it equals your tunnel
   > URL automatically). If they differ, Shopify shows
   > *"The redirect_uri is not whitelisted"*. **Save** after editing.

3. **API scopes:** under the app's API access / configuration, request
   these access scopes:
   - `read_orders`
   - `read_products`

4. **Protected customer data access** (THE most common blocker):
   `read_orders` returns **protected customer data**. In the dashboard
   open your app → **API access** → **Protected customer data access**
   → request/enable access. Enable:
   - **Protected customer data** (Orders), and
   - the **Customer PII fields** you need (name, phone, address, email).

   Without this the Orders API returns **HTTP 403** even with a valid
   token. (Apps not yet submitted for review can usually self-grant
   this in the dashboard for development/testing.)

### 7.2 Connect the store

1. Make sure `.env` has `SHOP_DOMAIN`, `SHOPIFY_API_KEY`,
   `SHOPIFY_API_SECRET`, and the Supabase keys, then run the server
   (`npm start`) and the tunnel.
2. In a **browser**, open `https://<PUBLIC_TUNNEL>/auth`
   (or click **ربط المتجر بشوبيفاي** in the UI — it navigates there).
3. You are sent to Shopify's authorize screen. Approve the app.
4. Shopify redirects back to `https://<PUBLIC_TUNNEL>/auth/callback`.
   The app verifies the `shop` regex, the `state` nonce (httpOnly
   cookie), and the **query HMAC** (hex SHA-256 of the alphabetically
   sorted query params with the app secret — separate from the
   base64 webhook-body HMAC), then exchanges the `code` for the
   **offline access token** and stores it in Supabase
   (`public.shopify_auth`, single row `id=1`). **The offline token
   does not expire.**
5. You return to the app with `?connected=1`; the *Connect Shopify*
   card now shows **Connected ✓** with the shop, scope and timestamp.

### 7.3 Build / verify the mapping on a real order

1. In the UI, *Connect Shopify* card → **تحميل آخر أوردر**
   (*Load last order*). The app calls
   `GET /api/shopify/last-order`, fetches the **most recent real
   order** (Admin REST `2025-01`, `orders.json?status=any&limit=1`
   newest-first), and shows each of the 12 template variables with its
   resolved value from the real order plus a per-variable mapping
   dropdown.
2. The dropdowns are pre-filled with the natural 1:1 mapping
   (`storeName→storeName`, … `orderPhoto→productImage`) or the saved
   mapping if one exists. **Review the real values first.**
3. Click **حفظ الربط / Save mapping**. Only then is the mapping saved
   (`POST /api/config`) with `selected_template_id=2094622431108343`,
   `phone_number_id=1115965254927153`, `store_name="For You Shoe"`,
   `default_country_code="20"`, `recipient_phone_source="customer"`.
   Nothing is auto-saved before you click.

> **403 on Load last order?** → step 7.1 #4 (Protected customer data
> access) is not enabled. **"Not connected"?** → run `/auth` first.

**عربي (مختصر):** مفاتيح شوبيفاي في `.env` هي بيانات تطبيق أنشأته في
لوحة Shopify Partner/Developer (وليست توكن تطبيق مخصص). في 2026 صار
المسار الصحيح هو OAuth. الخطوات:
1) شغّل نفقًا عامًا: `cloudflared tunnel --url http://localhost:3000`.
2) في لوحة الشريك (Partners) → تطبيقك → URLs: ضع *App URL* =
   `https://<PUBLIC_TUNNEL>` و *Allowed redirection URL* =
   `https://<PUBLIC_TUNNEL>/auth/callback` بنفس النص تمامًا.
3) الصلاحيات: `read_orders` و `read_products`.
4) فعّل **Protected customer data access** للأوردرات وبيانات العميل،
   وإلا سترجع الأوردرات خطأ 403.
5) افتح `https://<PUBLIC_TUNNEL>/auth` في المتصفح ووافق، سيعود متصلًا.
6) في الواجهة اضغط **تحميل آخر أوردر**، راجِع القيم الحقيقية، ثم
   **حفظ الربط**. التوكن (offline) يُحفظ في Supabase ولا تنتهي صلاحيته.

---

## 8. How HMAC verification works

Shopify sends `X-Shopify-Hmac-Sha256` =
`base64( HMAC_SHA256( rawRequestBody, sharedSecret ) )`.

This app captures the **raw request bytes** on the webhook route
(`express.raw`) and recomputes the digest with `SHOPIFY_API_SECRET`,
comparing in constant time (`crypto.timingSafeEqual`). A mismatch →
HTTP `401` and nothing is sent. (See `src/shopify.js`.)

---

## 9. Default Shopify → template variable resolvers

| Resolver id        | Value produced from the order |
| ------------------ | ----------------------------- |
| `storeName`        | `settings.store_name` (default derived from `SHOP_DOMAIN`) |
| `customerName`     | `customer.first_name + last_name`, fallback shipping/billing name |
| `orderId`          | `order.id` |
| `orderNumber`      | `order.name` (e.g. `#1001`) or `order.order_number` |
| `orderDescription` | line items joined as `"<qty>x <title>"`, comma separated |
| `orderCost`        | `total_price + " " + currency` |
| `orderStatus`      | `fulfillment_status` ?? `financial_status` ?? `pending` |
| `customerAddress`  | shipping address: address1, address2, city, province, country, zip |
| `otherAddress`     | billing address (same format) |
| `customerCity`     | shipping (fallback billing) `city` |
| `customerGovernorate` | shipping (fallback billing) `province` |
| `productImage`     | first line item image URL if present (often empty on webhooks → map to Static text with a URL) |
| `trackingNumber`   | tracking number(s) from `order.fulfillments[]` |
| `trackingLink`     | first tracking URL from `order.fulfillments[]` |
| `trackingUrl`      | alias for `trackingLink` |
| `trackingCompany`  | tracking carrier/company from `order.fulfillments[]` |

Each template variable is mapped (in the UI) to one of these resolvers
**or** to a static constant string. Mapping is stored in
`app_config.mapping` as `{ "<varName>": { "type": "resolver"|"static", "value": "..." } }`.

**Recipient phone selection & normalization** (`src/shopify.js`):

1. Pick the first non-empty of customer / shipping / billing / order
   phone (configurable via *recipient phone source*).
2. Strip spaces, dashes, parentheses, dots; strip a leading `+`.
3. Leading `00` → drop it (already international).
4. Leading `0` → local number: drop the `0`, prepend
   `DEFAULT_COUNTRY_CODE`.
5. Already starts with the country code → keep as-is.
6. Short (`< 11` digits) → assume local, prepend country code.
7. Otherwise assume already international.

Result: digits only, no `+` (joud.chat format). Override the country
code in *Settings* or via `DEFAULT_COUNTRY_CODE` in `.env`.

---

## 10. API routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/health` | `{ ok, supabase }` |
| GET  | `/api/meta` | resolver options + defaults |
| GET  | `/api/config` | current settings + mapping |
| POST | `/api/config` | save settings / mapping / template |
| GET  | `/api/templates?phone_number_id=` | proxy joud.chat template list |
| GET  | `/api/logs?limit=` | recent send logs |
| POST | `/api/test-send` | run a sample order through the pipeline |
| GET  | `/auth[?shop=]` | start Shopify OAuth (302 → authorize URL) |
| GET  | `/auth/callback` | OAuth callback: verify shop+state+HMAC, exchange code, store offline token |
| GET  | `/api/shopify/status` | `{ connected, shop, scope, obtained_at }` |
| GET  | `/api/shopify/last-order` | latest real order + 12-variable preview + suggestedMapping |
| POST | `/webhooks/shopify/orders-create` | Shopify webhook (HMAC verified) |
| POST | `/api/order-updates/run` | admin/manual trigger for fulfilled-order `order_update` sends |
| POST | `/webhooks/shopify/orders-updated` | optional near-real-time fulfilled-order update hook |
| POST | `/webhooks/shopify/orders-fulfilled` | optional near-real-time fulfilled-order update hook |

The webhook always returns `200` quickly (Shopify requirement); the
real outcome — success or the joud.chat error — is recorded in the
message log. External joud.chat calls are capped at ~10s. Idempotency
is best-effort: a successful send for the same `order id + template`
is skipped.

### Fulfilled-order tracking updates

The app also polls Shopify for recently updated orders whose
`fulfillment_status` is `fulfilled`. When a fulfilled order has both a
tracking number and a tracking URL in its `fulfillments[]`, it sends
the Meta template named by `META_ORDER_UPDATE_TEMPLATE_NAME`
(default: `order_update`). The tracking URL is sent as a dynamic URL
button parameter, and `message_log` idempotency prevents duplicate
`order_update` sends for the same Shopify order.

Manual test body:

```json
{ "scan_limit": 25, "send_limit": 1 }
```

Railway runs this in the normal web process:

```env
META_ORDER_UPDATE_TEMPLATE_NAME=order_update
META_ORDER_UPDATE_BUTTON_INDEX=0
ORDER_UPDATE_CRON_ENABLED=true
ORDER_UPDATE_CRON_INTERVAL_MS=60000
ORDER_UPDATE_CRON_BATCH_LIMIT=50
```

For faster delivery than the polling interval, register Shopify
webhooks for order update / fulfillment events pointing at:

```text
https://YOUR-PUBLIC-URL/webhooks/shopify/orders-updated
https://YOUR-PUBLIC-URL/webhooks/shopify/orders-fulfilled
```

---

## 11. Assumptions made

- The provided Shopify credentials are a **Partner/Developer app's**
  `client_id` / `client_secret` (confirmed by the user), so the Admin
  API token is obtained via **OAuth** (§7), not a custom-app token.
  The same secret also verifies the webhook body HMAC.
- **OAuth offline token flow** is used (no `grant_options[]`), so the
  stored token does not expire. It lives in `public.shopify_auth`
  (single row `id=1`, RLS on, no public policies — server uses the
  service-role key). In degraded mode it is held in memory only.
- `redirect_uri` is derived from the request host and honors
  `X-Forwarded-Host` / `X-Forwarded-Proto` so it matches a
  cloudflared/ngrok tunnel automatically; it must be whitelisted in
  the Partner dashboard exactly.
- Admin API version pinned to **`2025-01`** (REST) for order fetch.
  Latest order = `orders.json?status=any&limit=1&order=created_at+desc`
  with a client-side `created_at` re-sort as a safeguard.
- The real-order preview uses the **natural 1:1 mapping**
  (`orderPhoto→productImage`, all others identity) when no mapping is
  saved yet; the mapping is **never auto-saved** — the user must click
  *Save mapping* after reviewing real values.
- The OAuth `state` nonce is stored in an `httpOnly`, `SameSite=Lax`
  cookie (10-min TTL) and compared timing-safely on callback. A tiny
  built-in cookie parser is used — **no new dependencies added**.
- The webhook can still be registered via a custom app/Admin API as
  before (§6); OAuth here is specifically for reading orders/products.
- joud.chat `template/list` may return `message` as a single object
  **or** an array — both are handled. `template_json`, `variable_map`,
  `button_content` are JSON-encoded strings and are parsed defensively.
- Variable indices for the `templateVariable-<name>-<index>` keys are
  assigned 1-based in `variable_map` order (header then body); if
  `variable_map` is empty we scan `{{...}}` placeholders in the text.
- Default country code `20` (Egypt) per the brief; editable.
- No quick-reply button values are sent by default (`[]`); the parser
  detects quick-reply buttons but the brief did not specify values to
  inject, so they are left empty.
- Single config row (`id = 1`) — one mapping/template active at a time
  (matches the "one job, one page" brief).
```
