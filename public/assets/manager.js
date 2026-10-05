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

// Файлы, отданные только по токену в заголовке: скачиваем blob и открываем/сохраняем его.
async function adminFile(url, { filename, open } = {}) {
  const win = open ? window.open('', '_blank') : null;   // окно открываем сразу, иначе браузер заблокирует всплывающее
  const res = await fetch(url, { headers: { 'x-admin-token': TOKEN } });
  if (!res.ok) {
    if (win) win.close();
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Ошибка ${res.status}`);
  }
  const href = URL.createObjectURL(await res.blob());
  if (win) {
    win.location = href;
  } else {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename || '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

const markSent = (id, via) => api(`/api/admin/offers/${id}/sent`, { method: 'POST', body: JSON.stringify({ via }) })
  .then(() => refresh()).catch(() => {});

const waHref = (phone, text) => {
  const digits = (phone || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
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

// --------------------------------------------------------- вкладки

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  ['docTab', 'textTab'].forEach((id) => { $(id).hidden = id !== tab.dataset.tab; });
}));

// ------------------------------------------------- загрузка документа (Word или PDF)

let docFile = null;
let lastDoc = null;

function pickFile(file) {
  docFile = file || null;
  $('fileDrop').classList.toggle('has-file', Boolean(docFile));
  $('fileName').textContent = docFile
    ? `${docFile.name} · ${(docFile.size / 1024).toFixed(0)} КБ`
    : 'Выберите файл или перетащите его сюда';
  $('docError').classList.remove('show');
}

$('docFile').addEventListener('change', () => pickFile($('docFile').files[0]));
['dragenter', 'dragover'].forEach((ev) => $('fileDrop').addEventListener(ev, (e) => { e.preventDefault(); $('fileDrop').classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => $('fileDrop').addEventListener(ev, (e) => { e.preventDefault(); $('fileDrop').classList.remove('over'); }));
$('fileDrop').addEventListener('drop', (e) => pickFile(e.dataTransfer.files[0]));

$('uploadBtn').addEventListener('click', async () => {
  const btn = $('uploadBtn');
  const err = $('docError');
  err.classList.remove('show');
  if (!docFile) {
    err.textContent = 'Выберите файл .docx или .pdf';
    err.classList.add('show');
    return;
  }
  if (!/\.(docx|pdf)$/i.test(docFile.name)) {
    err.textContent = 'Нужен файл Word (.docx) или PDF. Старый .doc откройте в Word и сохраните как «Документ Word (.docx)».';
    err.classList.add('show');
    return;
  }

  const form = new FormData();
  form.append('file', docFile);
  [['title', 'docTitleInput'], ['clientName', 'docClientName'], ['phone', 'docPhone'], ['createdBy', 'docCreatedBy'], ['note', 'docNote']]
    .forEach(([k, id]) => { const v = $(id).value.trim(); if (v) form.append(k, v); });

  btn.disabled = true;
  btn.textContent = 'Подготавливаем документ…';
  try {
    const res = await fetch('/api/admin/docs', { method: 'POST', headers: { 'x-admin-token': TOKEN }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    lastDoc = data.offer;
    $('docCreated').hidden = false;
    $('docCreatedInfo').textContent = `«${data.offer.docTitle}» · ${data.offer.pageCount} стр. · ${data.offer.docNumber}`;
    $('docCreatedUrl').textContent = data.offer.url;
    $('docWaText').value = data.whatsappText;
    $('docWaLink').href = waHref(data.offer.phoneHint, data.whatsappText);
    ['docTitleInput', 'docClientName', 'docPhone', 'docNote'].forEach((id) => { $(id).value = ''; });
    $('docFile').value = '';
    pickFile(null);
    await refresh();
    $('docCreated').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    err.textContent = e.message;
    err.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Загрузить и создать ссылку';
  }
});

$('docPreview').addEventListener('click', () => lastDoc && adminFile(`/api/admin/offers/${lastDoc.id}/source.pdf`, { open: true }).catch((e) => alert(e.message)));
$('docCopyUrl').addEventListener('click', (e) => { copy($('docCreatedUrl').textContent, e.target); if (lastDoc) markSent(lastDoc.id, 'copy'); });
$('docCopyWa').addEventListener('click', (e) => { copy($('docWaText').value, e.target); if (lastDoc) markSent(lastDoc.id, 'copy'); });
$('docWaLink').addEventListener('click', () => { if (lastDoc) markSent(lastDoc.id, 'whatsapp'); });

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

const STAGES = {
  ready: 'готов к отправке',
  sent: 'отправлен клиенту',
  viewing: 'клиент просматривает',
  awaiting_signature: 'ожидает подписания',
  signed: 'подписан',
  cancelled: 'отменён',
};

const EVENT_TEXT = {
  created: (e) => `Документ создан${e.by ? ` (${e.by})` : ''}`,
  uploaded: (e) => `Загружен файл «${e.file}»`,
  converted: (e) => `Подготовлен для просмотра: ${e.pages} стр.`,
  sent: (e) => (e.via === 'whatsapp' ? 'Ссылка отправлена клиенту (WhatsApp)' : 'Ссылка скопирована для отправки клиенту'),
  opened: () => 'Клиент открыл документ',
  page_viewed: (e) => `Клиент просмотрел страницу №${e.page}`,
  page_acked: (e) => `Клиент подтвердил страницу №${e.page}`,
  name_entered: (e) => `Клиент ввёл ФИО: ${e.name}`,
  signature_drawn: () => 'Клиент поставил подпись',
  signed: () => 'Документ подписан',
  cancelled: () => 'Ссылка отменена',
};

const fmtFull = (iso) => new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(new Date(iso));

async function toggleJournal(id, holder) {
  if (!holder.hidden) { holder.hidden = true; return; }
  holder.hidden = false;
  holder.innerHTML = '<div><span>Загружаем…</span></div>';
  try {
    const { events } = await api(`/api/admin/offers/${id}/events`);
    holder.innerHTML = events.length
      ? events.map((e) => `<div><time>${fmtFull(e.at)}</time><span>${esc((EVENT_TEXT[e.type] || (() => e.type))(e))}${e.ip ? ` <small>· IP ${esc(e.ip)}</small>` : ''}</span></div>`).join('')
      : '<div><span>Журнал пуст</span></div>';
  } catch (e) {
    holder.innerHTML = `<div><span>${esc(e.message)}</span></div>`;
  }
}

function docxRow(o) {
  const badges = [
    `<span class="badge word">${o.sourceFormat === 'pdf' ? 'PDF' : 'Word'}</span>`,
    `<span class="badge ${o.stage}">${STAGES[o.stage] || o.stage}</span>`,
  ];
  if (o.status === 'draft') badges.push(`<span class="badge opened">стр. ${o.pagesAcked}/${o.pageCount} подтверждено</span>`);

  const meta = [
    `«${esc(o.docTitle)}» · ${o.pageCount} стр.`,
    `создан ${fmt(o.createdAt)}`,
    o.createdBy ? `менеджер: ${esc(o.createdBy)}` : '',
    o.sentAt ? `отправлен ${fmt(o.sentAt)}` : '',
    o.firstOpenedAt ? `открыт ${fmt(o.firstOpenedAt)}` : '',
    o.status === 'signed' ? `подписан ${fmt(o.signedAt)}` : '',
    o.phoneHint ? esc(o.phoneHint) : '',
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
        ${o.status !== 'cancelled' ? `<button data-copy-link="${esc(o.url)}" data-sent-id="${o.id}">Копировать ссылку</button>` : ''}
        ${o.pdfUrl ? `<a class="primary" href="${esc(o.pdfUrl)}" target="_blank" rel="noopener">Скачать подписанный PDF</a>` : ''}
        <button data-journal="${o.id}">Журнал</button>
        <button data-preview="${o.id}">Просмотр</button>
        <button data-source="${o.id}" data-source-name="${esc(o.sourceName || `${o.docNumber}.${o.sourceFormat}`)}">Оригинал .${o.sourceFormat}</button>
        ${o.status === 'draft' ? `<button data-cancel="${o.id}">Отменить ссылку</button>` : ''}
      </div>
      <div class="journal" data-journal-holder="${o.id}" hidden></div>
    </div>`;
}

function renderList() {
  const items = OFFERS.filter((o) => {
    if (FILTER === 'all') return true;
    if (FILTER === 'deadline') return o.bookingDeadline && o.status === 'signed';
    if (FILTER === 'docx') return o.kind === 'docx';
    if (FILTER === 'viewing') return o.status === 'draft' && ['viewing', 'awaiting_signature'].includes(o.stage);
    return o.status === FILTER;
  });

  if (!items.length) {
    $('list').innerHTML = '<div class="empty">Пока пусто</div>';
    return;
  }

  $('list').innerHTML = items.map((o) => {
    if (o.kind === 'docx') return docxRow(o);
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

  $('list').querySelectorAll('[data-copy-link]').forEach((b) => b.addEventListener('click', (e) => {
    copy(b.dataset.copyLink, e.target);
    if (b.dataset.sentId) {
      const o = OFFERS.find((x) => x.id === b.dataset.sentId);
      if (o && !o.sentAt) markSent(o.id, 'copy');
    }
  }));
  $('list').querySelectorAll('[data-journal]').forEach((b) => b.addEventListener('click', () => {
    toggleJournal(b.dataset.journal, $('list').querySelector(`[data-journal-holder="${b.dataset.journal}"]`));
  }));
  $('list').querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', () => {
    adminFile(`/api/admin/offers/${b.dataset.preview}/source.pdf`, { open: true }).catch((e) => alert(e.message));
  }));
  $('list').querySelectorAll('[data-source]').forEach((b) => b.addEventListener('click', () => {
    adminFile(`/api/admin/offers/${b.dataset.source}/original`, { filename: b.dataset.sourceName }).catch((e) => alert(e.message));
  }));
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
