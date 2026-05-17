/* ============================================================
   app.js — single-page UI logic. Plain ES, no dependencies.
   ============================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let META = { resolvers: [], defaults: {}, supabaseEnabled: false };
  let CONFIG = { settings: {}, mapping: {}, selected_template_id: '', phone_number_id: '' };
  let TEMPLATES = [];
  let CURRENT_TEMPLATE = null;

  // ---- toast ----
  let toastTimer = null;
  function toast(msg, kind = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
  }

  // ---- admin token (kept in the browser, never in served JS) ----
  const ADMIN_KEY = 'sw_admin_token';
  function getAdminToken() {
    try { return localStorage.getItem(ADMIN_KEY) || ''; } catch { return ''; }
  }
  function setAdminToken(v) {
    try { localStorage.setItem(ADMIN_KEY, v || ''); } catch { /* ignore */ }
  }
  function promptAdminToken(msg) {
    const v = window.prompt(
      msg || 'أدخل رمز الأدمن (ADMIN_UI_TOKEN من ملف .env):',
      getAdminToken()
    );
    if (v != null) setAdminToken(v.trim());
    return getAdminToken();
  }

  async function api(path, opts = {}, _retried = false) {
    const o = { ...opts };
    const tok = getAdminToken();
    o.headers = { ...(opts.headers || {}) };
    if (tok) o.headers['x-admin-token'] = tok;

    const res = await fetch(path, o);
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }

    // Guarded route rejected the (missing/wrong) admin token: ask
    // for it once and retry the same request.
    if (
      res.status === 401 &&
      data &&
      /admin token/i.test(String(data.error || '')) &&
      !_retried
    ) {
      const entered = promptAdminToken(
        getAdminToken()
          ? 'رمز الأدمن غير صحيح. أدخله من جديد:'
          : 'هذا الإجراء محمي. أدخل رمز الأدمن (ADMIN_UI_TOKEN):'
      );
      if (entered) return api(path, opts, true);
    }

    if (!res.ok || (data && data.ok === false)) {
      const err = (data && data.error) || `HTTP ${res.status}`;
      throw new Error(err);
    }
    return data;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- health ----
  async function loadHealth() {
    try {
      const h = await api('/api/health');
      $('healthDot').className = 'dot ok';
      $('healthText').textContent = 'متصل';
      $('supabaseBadge').textContent = h.supabase ? 'Supabase: متصل' : 'Supabase: وضع مؤقت (ذاكرة)';
      $('supabaseBadge').className = 'badge ' + (h.supabase ? 'ok' : 'warn');
    } catch {
      $('healthDot').className = 'dot bad';
      $('healthText').textContent = 'غير متصل';
    }
  }

  // ---- meta + config ----
  async function loadMeta() {
    const m = await api('/api/meta');
    META = m;
    $('shopBadge').textContent = m.shopDomain || '';
  }

  async function loadMetaInfo() {
    try {
      const m = await api('/api/meta/info');
      const b = $('metaBadge');
      if (m.configured) {
        const num =
          (m.numbers && m.numbers[0] && m.numbers[0].display) || '';
        b.textContent = `إرسال: Meta مباشر ${num ? '· ' + num : ''}`;
        b.className = 'badge ok';
      } else {
        b.textContent = 'إرسال: joud.chat';
        b.className = 'badge warn';
      }
    } catch {
      $('metaBadge').textContent = '';
    }
  }

  async function loadConfig() {
    const r = await api('/api/config');
    CONFIG = r.config;
    const s = CONFIG.settings || {};
    $('phoneNumberId').value = CONFIG.phone_number_id || META.defaultPhoneNumberId || '';
    $('storeName').value = s.store_name || (META.defaults && META.defaults.storeName) || '';
    $('countryCode').value =
      s.default_country_code || (META.defaults && META.defaults.defaultCountryCode) || '';
    $('phoneSource').value = s.recipient_phone_source || 'shipping';
  }

  // ---- settings save ----
  $('saveSettings').addEventListener('click', async () => {
    try {
      const body = {
        phone_number_id: $('phoneNumberId').value.trim(),
        settings: {
          store_name: $('storeName').value.trim(),
          default_country_code: $('countryCode').value.trim(),
          recipient_phone_source: $('phoneSource').value,
        },
      };
      const r = await api('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      CONFIG = r.config;
      toast('تم حفظ الإعدادات', 'ok');
    } catch (e) {
      toast('فشل الحفظ: ' + e.message, 'bad');
    }
  });

  // ---- templates ----
  $('loadTemplates').addEventListener('click', loadTemplates);

  async function loadTemplates() {
    const btn = $('loadTemplates');
    btn.disabled = true;
    btn.textContent = 'جارٍ التحميل…';
    try {
      const pnid = $('phoneNumberId').value.trim();
      const r = await api('/api/templates?phone_number_id=' + encodeURIComponent(pnid));
      TEMPLATES = r.templates || [];
      const sel = $('templateSelect');
      sel.innerHTML = '<option value="">— اختر قالبًا —</option>';
      TEMPLATES.forEach((t) => {
        const o = document.createElement('option');
        o.value = t.templateId;
        o.textContent = `${t.name} (${t.templateId})`;
        sel.appendChild(o);
      });
      if (CONFIG.selected_template_id) {
        sel.value = CONFIG.selected_template_id;
        onTemplateChange();
      }
      toast(`تم تحميل ${TEMPLATES.length} قالب`, 'ok');
    } catch (e) {
      toast('فشل تحميل القوالب: ' + e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = 'تحميل القوالب';
    }
  }

  $('templateSelect').addEventListener('change', onTemplateChange);

  function onTemplateChange() {
    const id = $('templateSelect').value;
    CURRENT_TEMPLATE = TEMPLATES.find((t) => String(t.templateId) === String(id)) || null;
    if (!CURRENT_TEMPLATE) {
      $('templatePreview').classList.add('hidden');
      $('mappingArea').innerHTML = '<p class="muted">اختر قالبًا أولًا لعرض متغيراته.</p>';
      $('saveMapping').disabled = true;
      return;
    }
    $('templatePreview').classList.remove('hidden');
    $('templateBody').textContent =
      (CURRENT_TEMPLATE.header ? CURRENT_TEMPLATE.header + '\n\n' : '') +
      (CURRENT_TEMPLATE.body || '(لا يوجد نص)');

    const vc = $('templateVars');
    vc.innerHTML = '';
    CURRENT_TEMPLATE.variables.forEach((v) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = `${v.name} #${v.index}`;
      vc.appendChild(c);
    });
    if (CURRENT_TEMPLATE.variables.length === 0) {
      vc.innerHTML = '<span class="muted">لا توجد متغيرات في هذا القالب.</span>';
    }
    renderMapping();
  }

  // ---- mapping ----
  function renderMapping() {
    const area = $('mappingArea');
    area.innerHTML = '';
    if (!CURRENT_TEMPLATE || CURRENT_TEMPLATE.variables.length === 0) {
      area.innerHTML = '<p class="muted">لا توجد متغيرات تحتاج للربط.</p>';
      $('saveMapping').disabled = CURRENT_TEMPLATE ? false : true;
      return;
    }
    const map = CONFIG.mapping || {};

    CURRENT_TEMPLATE.variables.forEach((v) => {
      const cur = map[v.name] || { type: 'resolver', value: '' };
      const row = document.createElement('div');
      row.className = 'map-row';

      const name = document.createElement('div');
      name.className = 'var-name';
      name.textContent = `${v.name} #${v.index}`;
      name.title = v.name;

      const typeSel = document.createElement('select');
      typeSel.innerHTML =
        '<option value="resolver">حقل من الطلب</option>' +
        '<option value="static">نص ثابت</option>';
      typeSel.value = cur.type === 'static' ? 'static' : 'resolver';

      const valWrap = document.createElement('div');

      function buildValueInput() {
        valWrap.innerHTML = '';
        if (typeSel.value === 'static') {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = 'نص ثابت يُرسل كما هو';
          inp.value = cur.type === 'static' ? cur.value || '' : '';
          inp.dataset.var = v.name;
          inp.dataset.kind = 'static';
          valWrap.appendChild(inp);
        } else {
          const sel = document.createElement('select');
          sel.dataset.var = v.name;
          sel.dataset.kind = 'resolver';
          sel.innerHTML = '<option value="">— اختر حقلًا —</option>';
          META.resolvers.forEach((r) => {
            const o = document.createElement('option');
            o.value = r.id;
            o.textContent = `${r.label} (${r.id})`;
            sel.appendChild(o);
          });
          // smart default: match resolver id to variable name
          const guess =
            cur.type === 'resolver' && cur.value
              ? cur.value
              : META.resolvers.some((r) => r.id === v.name)
              ? v.name
              : '';
          sel.value = guess;
          valWrap.appendChild(sel);
        }
      }
      buildValueInput();
      typeSel.addEventListener('change', buildValueInput);

      row.appendChild(name);
      row.appendChild(typeSel);
      row.appendChild(valWrap);
      area.appendChild(row);
    });

    $('saveMapping').disabled = false;
  }

  $('saveMapping').addEventListener('click', async () => {
    if (!CURRENT_TEMPLATE) return;
    const mapping = {};
    document.querySelectorAll('#mappingArea [data-var]').forEach((el) => {
      const name = el.dataset.var;
      const kind = el.dataset.kind;
      mapping[name] = { type: kind, value: el.value };
    });
    try {
      const r = await api('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mapping,
          selected_template_id: CURRENT_TEMPLATE.templateId,
          phone_number_id: $('phoneNumberId').value.trim(),
        }),
      });
      CONFIG = r.config;
      toast('تم حفظ الربط والقالب', 'ok');
    } catch (e) {
      toast('فشل حفظ الربط: ' + e.message, 'bad');
    }
  });

  // ---- test send ----
  $('sendTest').addEventListener('click', async () => {
    const phone = $('testPhone').value.trim();
    if (!phone) return toast('أدخل رقم هاتف للتجربة', 'bad');
    const btn = $('sendTest');
    btn.disabled = true;
    btn.textContent = 'جارٍ الإرسال…';
    try {
      const body = { phone_number: phone };
      if (CURRENT_TEMPLATE) body.template_id = CURRENT_TEMPLATE.templateId;
      const pnid = $('phoneNumberId').value.trim();
      if (pnid) body.phone_number_id = pnid;
      const r = await api('/api/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const el = $('testResult');
      el.classList.remove('hidden');
      el.textContent = JSON.stringify(r.result, null, 2);
      toast(r.result.success ? 'تم الإرسال بنجاح' : 'لم ينجح الإرسال — راجع التفاصيل',
        r.result.success ? 'ok' : 'bad');
      loadLogs();
    } catch (e) {
      toast('فشل الإرسال التجريبي: ' + e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = 'إرسال تجريبي';
    }
  });

  // ---- logs / monitoring (paginated + error filter) ----
  const LOGS_LIMIT = 20;
  let logsPage = 1;
  let logsTotal = 0;

  $('refreshLogs').addEventListener('click', () => {
    logsPage = 1;
    loadLogs();
  });
  $('logsOnlyFailed').addEventListener('change', () => {
    logsPage = 1;
    loadLogs();
  });
  $('logsPrev').addEventListener('click', () => {
    if (logsPage > 1) {
      logsPage -= 1;
      loadLogs();
    }
  });
  $('logsNext').addEventListener('click', () => {
    const pages = Math.max(Math.ceil(logsTotal / LOGS_LIMIT), 1);
    if (logsPage < pages) {
      logsPage += 1;
      loadLogs();
    }
  });

  async function loadLogs() {
    const onlyFailed = $('logsOnlyFailed').checked;
    try {
      const qs =
        `/api/logs?page=${logsPage}&limit=${LOGS_LIMIT}` +
        (onlyFailed ? '&onlyFailed=1' : '');
      const r = await api(qs);
      const body = $('logsBody');
      const logs = r.logs || [];
      logsTotal = typeof r.total === 'number' ? r.total : logs.length;
      logsPage = r.page || logsPage;

      if (logs.length === 0) {
        body.innerHTML =
          '<tr><td colspan="6" class="muted">' +
          (onlyFailed ? 'لا توجد رسائل فاشلة 🎉' : 'لا توجد سجلات بعد.') +
          '</td></tr>';
      } else {
        body.innerHTML = logs
          .map((l) => {
            const t = l.created_at
              ? new Date(l.created_at).toLocaleString()
              : '';
            const ok = l.success
              ? '<span class="pill ok">نجح</span>'
              : '<span class="pill bad">فشل</span>';
            const rowCls = l.success ? '' : ' class="row-failed"';
            return `<tr${rowCls}>
              <td class="ltr">${esc(t)}</td>
              <td class="ltr">${esc(l.order_number || l.shopify_order_id || '')}</td>
              <td class="ltr">${esc(l.recipient_phone || '')}</td>
              <td class="ltr">${esc(l.template_id || '')}</td>
              <td>${ok}</td>
              <td class="resp">${esc((l.response || '').slice(0, 800))}</td>
            </tr>`;
          })
          .join('');
      }
      updateLogsPager();
    } catch (e) {
      toast('فشل تحميل السجلات: ' + e.message, 'bad');
    }
  }

  function updateLogsPager() {
    const pages = Math.max(Math.ceil(logsTotal / LOGS_LIMIT), 1);
    $('logsPageInfo').textContent =
      `صفحة ${logsPage} من ${pages} · إجمالي ${logsTotal}`;
    $('logsPrev').disabled = logsPage <= 1;
    $('logsNext').disabled = logsPage >= pages;
  }

  // ============================================================
  //  Unconfirmed orders — list / send one / send all
  // ============================================================
  const UC_LIMIT = 20;
  let ucPage = 1;
  let ucTotal = 0;
  let ucLoaded = false;

  $('loadUnconfirmed').addEventListener('click', () => {
    ucPage = 1;
    loadUnconfirmed();
  });
  $('ucPrev').addEventListener('click', () => {
    if (ucPage > 1) {
      ucPage -= 1;
      loadUnconfirmed();
    }
  });
  $('ucNext').addEventListener('click', () => {
    const pages = Math.max(Math.ceil(ucTotal / UC_LIMIT), 1);
    if (ucPage < pages) {
      ucPage += 1;
      loadUnconfirmed();
    }
  });

  function updateUcPager() {
    const pages = Math.max(Math.ceil(ucTotal / UC_LIMIT), 1);
    $('ucPageInfo').textContent = ucLoaded
      ? `صفحة ${ucPage} من ${pages} · إجمالي ${ucTotal}`
      : '—';
    $('ucPrev').disabled = !ucLoaded || ucPage <= 1;
    $('ucNext').disabled = !ucLoaded || ucPage >= pages;
  }

  async function loadUnconfirmed() {
    const btn = $('loadUnconfirmed');
    btn.disabled = true;
    btn.textContent = 'جارٍ التحميل…';
    $('unconfirmedError').classList.add('hidden');
    try {
      const r = await api(
        `/api/orders/unconfirmed?page=${ucPage}&limit=${UC_LIMIT}`
      );
      ucLoaded = true;
      ucTotal = typeof r.total === 'number' ? r.total : 0;
      ucPage = r.page || ucPage;
      renderUnconfirmed(r.orders || []);
      updateUcPager();
      toast(`تم تحميل ${ucTotal} طلب غير مؤكد`, 'ok');
    } catch (e) {
      const box = $('unconfirmedError');
      box.textContent = 'تعذّر تحميل الطلبات غير المؤكدة: ' + e.message;
      box.classList.remove('hidden');
      toast('تعذّر تحميل الطلبات', 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = 'تحميل الطلبات غير المؤكدة';
    }
  }

  function renderUnconfirmed(orders) {
    const body = $('unconfirmedBody');
    if (!orders.length) {
      body.innerHTML =
        '<tr><td colspan="7" class="muted">لا توجد طلبات غير مؤكدة 🎉</td></tr>';
      return;
    }
    body.innerHTML = '';
    orders.forEach((o) => {
      const tr = document.createElement('tr');
      const created = o.created_at
        ? new Date(o.created_at).toLocaleString()
        : '';
      const sent = o.alreadySent
        ? '<span class="pill ok">اتبعت</span>'
        : '<span class="pill bad">لسه</span>';
      tr.innerHTML =
        `<td class="ltr">${esc(o.name || o.order_number || o.id)}</td>` +
        `<td dir="auto">${esc(o.customer_name || '')}</td>` +
        `<td class="ltr">${esc(o.phone || '')}</td>` +
        `<td class="ltr">${esc(
          `${o.total_price || ''} ${o.currency || ''}`.trim()
        )}</td>` +
        `<td class="ltr">${esc(created)}</td>` +
        `<td>${sent}</td>` +
        `<td class="actions"></td>`;
      const actionTd = tr.querySelector('td.actions');
      const sendBtn = document.createElement('button');
      sendBtn.className = 'btn primary sm';
      sendBtn.textContent = 'إرسال';
      sendBtn.addEventListener('click', () =>
        sendOneOrder(o, sendBtn, tr)
      );
      actionTd.appendChild(sendBtn);
      body.appendChild(tr);
    });
  }

  async function sendOneOrder(order, btn, tr) {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '… جارٍ الإرسال';
    try {
      const r = await api(
        `/api/orders/${encodeURIComponent(order.id)}/send`,
        { method: 'POST' }
      );
      const ok = r.result && r.result.success;
      if (ok) {
        const cell = tr.children[5];
        if (cell) cell.innerHTML = '<span class="pill ok">اتبعت</span>';
        btn.textContent = 'تم ✓';
        toast(
          `تم إرسال التأكيد للأوردر ${order.name || order.order_number}`,
          'ok'
        );
      } else {
        btn.disabled = false;
        btn.textContent = original;
        toast(
          'لم ينجح الإرسال: ' +
            ((r.result && r.result.response) || 'راجع السجل'),
          'bad'
        );
      }
      loadLogs();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      toast('فشل الإرسال: ' + e.message, 'bad');
    }
  }

  async function runSendAll(btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جارٍ الإرسال للكل…';
    $('unconfirmedError').classList.add('hidden');
    try {
      const r = await api('/api/orders/send-all', { method: 'POST' });
      const summary =
        `تمت محاولة ${r.attempted} — نجح ${r.sent} · فشل ${r.failed}` +
        (r.remaining > 0 ? ` · متبقّي ${r.remaining}` : '');
      $('unconfirmedMeta').textContent = summary;
      toast(
        summary,
        r.failed === 0 && r.attempted > 0
          ? 'ok'
          : r.attempted === 0
          ? ''
          : 'bad'
      );
      // Surface per-order failures inline for monitoring.
      const fails = (r.results || []).filter((x) => !x.success);
      if (fails.length) {
        const box = $('unconfirmedError');
        box.textContent =
          'طلبات لم تُرسل:\n' +
          fails
            .map(
              (x) =>
                `#${x.order_number || '?'} :: ${(x.response || '').slice(
                  0,
                  300
                )}`
            )
            .join('\n');
        box.classList.remove('hidden');
      }
      // Offer the next batch if Shopify still has more pending.
      const nextBtn = $('sendNextBatch');
      if (r.remaining > 0) nextBtn.classList.remove('hidden');
      else nextBtn.classList.add('hidden');
      // Refresh the list + logs to reflect new sends.
      ucPage = 1;
      await loadUnconfirmed();
      loadLogs();
    } catch (e) {
      toast('فشل الإرسال للكل: ' + e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  $('sendAllUnconfirmed').addEventListener('click', () =>
    runSendAll($('sendAllUnconfirmed'))
  );
  $('sendNextBatch').addEventListener('click', () =>
    runSendAll($('sendNextBatch'))
  );

  // ============================================================
  //  Shopify OAuth connect + real last-order preview
  // ============================================================
  let LAST_ORDER_PREVIEW = []; // [{ index, name, mappingType, mappingValue, resolvedValue }]

  async function loadShopifyStatus() {
    try {
      const s = await api('/api/shopify/status');
      const dot = $('shopifyDot');
      const txt = $('shopifyStatusText');
      const meta = $('shopifyStatusMeta');
      // Prefill the sub-domain field from the known shop.
      if (s.shop && !$('shopSubDomain').value) {
        $('shopSubDomain').value = s.shop.replace(/\.myshopify\.com$/i, '');
      }
      if (s.connected && !s.expired) {
        dot.className = 'dot ok';
        txt.textContent = 'متصل ✓ Connected';
        const exp = s.expires_at
          ? new Date(s.expires_at).toLocaleString()
          : '';
        meta.textContent =
          `${s.shop || ''}` +
          (s.scope ? ` · ${s.scope}` : '') +
          (exp ? ` · ينتهي: ${exp}` : '');
      } else if (s.connected && s.expired) {
        dot.className = 'dot warn';
        txt.textContent = 'الرمز منتهي — يتجدّد تلقائيًا عند الاستخدام';
        meta.textContent = `${s.shop || ''}${s.scope ? ' · ' + s.scope : ''}`;
      } else {
        dot.className = 'dot bad';
        txt.textContent = 'غير متصل — اضغط «توليد رمز الوصول»';
        meta.textContent = s.shop ? `(${s.shop})` : '';
      }
      return s;
    } catch (e) {
      $('shopifyDot').className = 'dot bad';
      $('shopifyStatusText').textContent = 'تعذّر فحص حالة الاتصال';
      $('shopifyStatusMeta').textContent = '';
      return { connected: false };
    }
  }

  // Headless client-credentials token generation (no browser/OAuth).
  $('generateToken').addEventListener('click', async () => {
    const btn = $('generateToken');
    btn.disabled = true;
    btn.textContent = 'جارٍ التوليد…';
    try {
      const body = {
        store_sub_domain:
          $('shopSubDomain').value.trim() || (META.shopDomain || ''),
      };
      const cid = $('shopClientId').value.trim();
      const csec = $('shopClientSecret').value.trim();
      if (cid) body.client_id = cid;
      if (csec) body.client_secret = csec;

      const r = await api('/api/shopify/generate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      $('genToken').textContent = r.access_token || '';
      $('genScope').textContent = r.scope || '';
      $('genExpires').textContent = (r.expires_in || 0) + ' seconds';
      $('tokenResultBox').classList.remove('hidden');
      await loadShopifyStatus();
      toast('تم توليد رمز الوصول بنجاح ✓', 'ok');
    } catch (e) {
      toast('فشل توليد الرمز: ' + e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔑 توليد رمز الوصول / Generate Access Token';
    }
  });

  $('copyToken').addEventListener('click', async () => {
    const t = $('genToken').textContent || '';
    try {
      await navigator.clipboard.writeText(t);
      toast('تم نسخ الرمز', 'ok');
    } catch {
      toast('انسخ الرمز يدويًا', 'bad');
    }
  });

  function renderOrderSummary(order, recipientPhone, template, mappingSource) {
    const box = $('orderSummary');
    if (!order) {
      box.innerHTML = '';
      return;
    }
    const kv = (label, val) =>
      `<div class="kv"><b>${esc(label)}</b><span dir="auto">${
        esc(val) || '<span class="empty-val">—</span>'
      }</span></div>`;
    const items = (order.line_items || [])
      .map((li) => `${li.quantity}× ${li.title}`)
      .join('، ');
    box.innerHTML =
      kv('رقم الأوردر', order.name || order.order_number || order.id) +
      kv('التاريخ', order.created_at
        ? new Date(order.created_at).toLocaleString()
        : '') +
      kv('الإجمالي', `${order.total_price || ''} ${order.currency || ''}`.trim()) +
      kv('حالة الدفع', order.financial_status || '') +
      kv('العميل', order.customer
        ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
        : '') +
      kv('هاتف الإرسال (بعد التطبيع)', recipientPhone || '') +
      kv('المنتجات', items) +
      kv('القالب', template
        ? `${template.name} (${template.variableCount} متغير)`
        : '—') +
      kv('مصدر الربط الحالي',
        mappingSource === 'saved' ? 'ربط محفوظ' : 'تلقائي 1:1 (للمراجعة)');
  }

  function renderPreviewTable(preview) {
    const body = $('previewBody');
    body.innerHTML = '';
    if (!preview || preview.length === 0) {
      body.innerHTML =
        '<tr><td colspan="4" class="muted">لم يتم العثور على متغيرات القالب. ' +
        'تأكد من تحميل القوالب أولًا.</td></tr>';
      return;
    }
    preview.forEach((p) => {
      const tr = document.createElement('tr');

      const idxTd = document.createElement('td');
      idxTd.textContent = p.index;

      const nameTd = document.createElement('td');
      nameTd.className = 'var-cell';
      nameTd.textContent = p.name;

      const mapTd = document.createElement('td');
      const ctrl = document.createElement('div');
      ctrl.className = 'map-controls';

      const typeSel = document.createElement('select');
      typeSel.innerHTML =
        '<option value="resolver">حقل من الطلب</option>' +
        '<option value="static">نص ثابت / Static text</option>';
      typeSel.value = p.mappingType === 'static' ? 'static' : 'resolver';

      const valWrap = document.createElement('div');

      function buildVal() {
        valWrap.innerHTML = '';
        if (typeSel.value === 'static') {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = 'نص ثابت يُرسل كما هو';
          inp.value = p.mappingType === 'static' ? p.mappingValue || '' : '';
          inp.dataset.var = p.name;
          inp.dataset.kind = 'static';
          valWrap.appendChild(inp);
        } else {
          const sel = document.createElement('select');
          sel.dataset.var = p.name;
          sel.dataset.kind = 'resolver';
          sel.innerHTML = '<option value="">— اختر حقلًا —</option>';
          (META.resolvers || []).forEach((r) => {
            const o = document.createElement('option');
            o.value = r.id;
            o.textContent = `${r.label} (${r.id})`;
            sel.appendChild(o);
          });
          sel.value =
            p.mappingType === 'resolver' && p.mappingValue
              ? p.mappingValue
              : '';
          valWrap.appendChild(sel);
        }
      }
      buildVal();
      typeSel.addEventListener('change', buildVal);
      ctrl.appendChild(typeSel);
      ctrl.appendChild(valWrap);
      mapTd.appendChild(ctrl);

      const valTd = document.createElement('td');
      valTd.className = 'val';
      if (p.resolvedValue === '' || p.resolvedValue == null) {
        valTd.innerHTML = '<span class="empty-val">(فارغ)</span>';
      } else {
        valTd.textContent = p.resolvedValue;
      }

      tr.appendChild(idxTd);
      tr.appendChild(nameTd);
      tr.appendChild(mapTd);
      tr.appendChild(valTd);
      body.appendChild(tr);
    });
  }

  $('loadLastOrder').addEventListener('click', async () => {
    const btn = $('loadLastOrder');
    btn.disabled = true;
    btn.textContent = 'جارٍ التحميل…';
    $('lastOrderError').classList.add('hidden');
    try {
      const r = await api('/api/shopify/last-order');
      LAST_ORDER_PREVIEW = r.preview || [];
      renderOrderSummary(
        r.order,
        r.recipientPhone,
        r.template,
        r.mappingSource
      );
      $('mappingSourceHint').textContent =
        r.mappingSource === 'saved'
          ? 'القيم محسوبة باستخدام الربط المحفوظ حاليًا. عدّل ثم احفظ.'
          : 'لا يوجد ربط محفوظ بعد — هذه القيم محسوبة بالربط التلقائي 1:1 ' +
            'لمراجعتها. راجعها واضغط حفظ الربط لاعتمادها.';
      renderPreviewTable(LAST_ORDER_PREVIEW);
      $('lastOrderBox').classList.remove('hidden');
      toast('تم تحميل آخر أوردر', 'ok');
    } catch (e) {
      const box = $('lastOrderError');
      box.textContent = 'تعذّر تحميل آخر أوردر: ' + e.message;
      box.classList.remove('hidden');
      $('lastOrderBox').classList.add('hidden');
      toast('تعذّر تحميل آخر أوردر', 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = 'تحميل آخر أوردر';
    }
  });

  $('saveRealMapping').addEventListener('click', async () => {
    const mapping = {};
    document
      .querySelectorAll('#previewTable [data-var]')
      .forEach((el) => {
        mapping[el.dataset.var] = {
          type: el.dataset.kind,
          value: el.value,
        };
      });
    if (Object.keys(mapping).length === 0) {
      return toast('لا يوجد متغيرات للحفظ', 'bad');
    }
    const btn = $('saveRealMapping');
    btn.disabled = true;
    btn.textContent = 'جارٍ الحفظ…';
    try {
      const r = await api('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mapping,
          selected_template_id: '2094622431108343',
          phone_number_id: '1115965254927153',
          settings: {
            store_name: 'For You Shoe',
            default_country_code: '20',
            recipient_phone_source: 'shipping',
          },
        }),
      });
      CONFIG = r.config;
      // Reflect saved values back into the basic settings form too.
      const s = CONFIG.settings || {};
      $('phoneNumberId').value = CONFIG.phone_number_id || '';
      $('storeName').value = s.store_name || '';
      $('countryCode').value = s.default_country_code || '';
      $('phoneSource').value = s.recipient_phone_source || 'shipping';
      toast('تم حفظ الربط على بيانات الأوردر الحقيقي', 'ok');
    } catch (e) {
      toast('فشل حفظ الربط: ' + e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = 'حفظ الربط / Save mapping';
    }
  });

  // ---- test send using the REAL last order, to a chosen number ----
  $('sendTestLastOrder').addEventListener('click', async () => {
    const phone = $('testLastOrderPhone').value.trim();
    if (!phone) return toast('اكتب رقم الهاتف للتجربة', 'bad');
    const btn = $('sendTestLastOrder');
    btn.disabled = true;
    btn.textContent = 'جارٍ الإرسال…';
    const out = $('testLastOrderResult');
    try {
      const r = await api('/api/shopify/test-last-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phone }),
      });
      out.classList.remove('hidden');
      out.textContent = JSON.stringify(r.result, null, 2);
      const ok = r.result && r.result.success;
      toast(
        ok ? 'تم الإرسال ✓ تحقق من واتساب' : 'لم ينجح الإرسال — راجع التفاصيل',
        ok ? 'ok' : 'bad'
      );
      loadLogs();
    } catch (e) {
      out.classList.remove('hidden');
      out.textContent = 'خطأ: ' + e.message;
      toast('فشل الإرسال: ' + e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = 'إرسال إلى هذا الرقم';
    }
  });

  // ---- init ----
  (async function init() {
    await loadHealth();
    try {
      await loadMeta();
      await loadMetaInfo();
      await loadConfig();
      await loadShopifyStatus();
      await loadLogs();
    } catch (e) {
      toast('تعذّر تحميل البيانات: ' + e.message, 'bad');
    }

    // Returned from Shopify OAuth?
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === '1') {
      toast('تم ربط المتجر بشوبيفاي بنجاح ✓', 'ok');
      await loadShopifyStatus();
      // Clean the ?connected=1 from the URL.
      window.history.replaceState({}, '', window.location.pathname);
    }

    setInterval(loadHealth, 30000);
  })();
})();
