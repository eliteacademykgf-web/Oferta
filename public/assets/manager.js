'use strict';

/* Кабинет менеджера: создание персональных ссылок, контроль подписей и сроков брони. */

const $ = (id) => document.getElementById(id);
const KEY = 'elite_offer_admin_token';
let TOKEN = localStorage.getItem(KEY) || '';
let OFFERS = [];
let FILTER = 'all';

const api = async (url, options = {}) => {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (iso, withTime = true) => (iso
  ? new Intl.DateTimeFormat('ru-RU', withTime
    ? { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(iso))
  : '—');

// ------------------------------------------------------------------- вход

async function login() {
  const value = $('tokenInput').value.trim();
  if (!value) return;
  TOKEN = value;
  try {
    await api('/api/admin/offers');
    localStorage.setItem(KEY, TOKEN);
    openPanel();
  } catch (e) {
    $('authError').textContent = e.message;
    $('authError').classList.add('show');
  }
}

$('loginBtn').addEventListener('click', login);
$('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

async function openPanel() {
  $('auth').hidden = true;
  $('panel').hidden = false;
  await Promise.all([loadDefaults(), refresh()]);
}

async function loadDefaults() {
  try {
    const { defaults } = await api('/api/admin/config');
    ['bookingFee', 'discountUsd', 'secondTrancheMin', 'secondTrancheMax', 'bookingDays', 'payWindowHours']
      .forEach((k) => { $(k).placeholder = `по умолчанию: ${defaults[k]}`; });
    $('packageName').placeholder = `по умолчанию: ${defaults.packageName}`;
  } catch { /* не критично */ }
}

// -------------------------------------------------------------- создание

$('createBtn').addEventListener('click', async () => {
  const btn = $('createBtn');
  const err = $('createError');
  err.classList.remove('show');
  btn.disabled = true;

  const body = {};
  ['clientName', 'phone', 'createdBy', 'packageName', 'note', 'bookingFee', 'discountUsd',
    'secondTrancheMin', 'secondTrancheMax', 'bookingDays', 'payWindowHours'].forEach((k) => {
    const v = $(k).value.trim();
    if (v) body[k] = v;
  });

  try {
    const { offer, whatsappText } = await api('/api/admin/offers', { method: 'POST', body: JSON.stringify(body) });
    $('created').hidden = false;
    $('createdUrl').textContent = offer.url;
    $('waText').value = whatsappText;
    const digits = (offer.phoneHint || '').replace(/\D/g, '');
    $('waLink').href = digits
      ? `https://wa.me/${digits}?text=${encodeURIComponent(whatsappText)}`
      : `https://wa.me/?text=${encodeURIComponent(whatsappText)}`;
    ['clientName', 'phone', 'note'].forEach((k) => { $(k).value = ''; });
    await refresh();
    $('created').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    err.textContent = e.message;
    err.classList.add('show');
  } finally {
    btn.disabled = false;
  }
});

const copy = async (text, btn) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = 'Скопировано ✓';
  setTimeout(() => { btn.textContent = old; }, 1600);
};

$('copyUrl').addEventListener('click', (e) => copy($('createdUrl').textContent, e.target));
$('copyWa').addEventListener('click', (e) => copy($('waText').value, e.target));

// ---------------------------------------------------------------- список

$('refreshBtn').addEventListener('click', refresh);
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
  FILTER = chip.dataset.filter;
  renderList();
}));

async function refresh() {
  try {
    const { offers } = await api('/api/admin/offers');
    OFFERS = offers;
    renderList();
  } catch (e) {
    $('list').innerHTML = `<div class="msg error show">${esc(e.message)}</div>`;
  }
}

const daysLeft = (iso) => Math.ceil((new Date(iso) - Date.now()) / 86400000);

function renderList() {
  const items = OFFERS.filter((o) => {
    if (FILTER === 'all') return true;
    if (FILTER === 'deadline') return o.bookingDeadline && o.status === 'signed';
    return o.status === FILTER;
  });

  if (!items.length) {
    $('list').innerHTML = '<div class="empty">Пока пусто</div>';
    return;
  }

  $('list').innerHTML = items.map((o) => {
    const left = o.bookingDeadline ? daysLeft(o.bookingDeadline) : null;
    const badges = [`<span class="badge ${o.status}">${{ draft: 'ждёт подписи', signed: 'подписана', cancelled: 'отменена' }[o.status]}</span>`];
    if (o.status === 'draft' && o.opens) badges.push(`<span class="badge opened">открыл ${o.opens} раз</span>`);
    if (left !== null) {
      badges.push(`<span class="badge ${left <= 3 ? 'deadline' : 'opened'}">${left > 0 ? `до конца брони ${left} дн.` : 'срок брони истёк'}</span>`);
    }

    const meta = [
      `создана ${fmt(o.createdAt)}`,
      o.createdBy ? `менеджер: ${esc(o.createdBy)}` : '',
      o.status === 'signed' ? `подписана ${fmt(o.signedAt)}` : '',
      o.signedPhone ? esc(o.signedPhone) : (o.phoneHint ? esc(o.phoneHint) : ''),
      o.paidAt ? `оплата ${fmt(o.paidAt, false)} → бронь до ${fmt(o.bookingDeadline, false)}` : '',
      o.note ? `заметка: ${esc(o.note)}` : '',
    ].filter(Boolean);

    return `
      <div class="row">
        <div class="row-top">
          <span class="name">${esc(o.signedName || o.clientHint || 'Без имени')}</span>
          <span class="no">${esc(o.docNumber)}</span>
          ${badges.join('')}
        </div>
        <div class="row-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
        <div class="row-actions">
          <button data-copy-link="${esc(o.url)}">Копировать ссылку</button>
          ${o.pdfUrl ? `<a class="primary" href="${esc(o.pdfUrl)}" target="_blank" rel="noopener">Скачать PDF</a>` : ''}
          ${o.status === 'signed' && !o.paidAt ? `<button class="primary" data-paid="${o.id}">Оплата получена</button>` : ''}
          ${o.status === 'draft' ? `<button data-cancel="${o.id}">Отменить ссылку</button>` : ''}
        </div>
      </div>`;
  }).join('');

  $('list').querySelectorAll('[data-copy-link]').forEach((b) => b.addEventListener('click', (e) => copy(b.dataset.copyLink, e.target)));
  $('list').querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Отменить ссылку? Клиент больше не сможет подписать оферту по ней.')) return;
    await api(`/api/admin/offers/${b.dataset.cancel}/cancel`, { method: 'POST' });
    refresh();
  }));
  $('list').querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', async () => {
    const input = prompt('Дата поступления первого транша (ГГГГ-ММ-ДД). Пусто = сегодня:', '');
    const body = input && input.trim() ? JSON.stringify({ paidAt: input.trim() }) : '{}';
    try {
      await api(`/api/admin/offers/${b.dataset.paid}/paid`, { method: 'POST', body });
      refresh();
    } catch (e) {
      alert(e.message);
    }
  }));
}

if (TOKEN) {
  api('/api/admin/offers').then(openPanel).catch(() => { TOKEN = ''; localStorage.removeItem(KEY); });
}
