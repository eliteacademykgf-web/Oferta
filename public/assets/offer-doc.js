/* Подписание загруженного документа: старт → страницы по порядку с отметками → ФИО и подпись → готово.
   Каждая отметка сразу сохраняется на сервере, поэтому после перезагрузки клиент продолжает с того же места. */

import * as pdfjsLib from '/vendor/pdfjs/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';

const TOKEN = location.pathname.split('/').filter(Boolean)[1] || '';
const READ_DELAY_MS = 2000;          // через сколько после отрисовки страницы можно поставить отметку
const ZOOMS = [1, 1.5, 2, 2.5];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (iso) => new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));

const state = {
  data: null,
  pdf: null,
  page: 1,
  pageAcks: {},
  zoomIdx: 0,
  renderTask: null,
  unlockTimer: null,
  hasSignature: false,
  signatureDrawnAt: null,
  nameEnteredAt: null,
  finalAckAt: null,
};

const acked = () => Object.keys(state.pageAcks).length;
const total = () => state.data.pageCount;
const isAcked = (n) => Boolean(state.pageAcks[String(n)]);

// ------------------------------------------------------------------ загрузка

async function boot() {
  if (!TOKEN) return fail('Ссылка неполная. Запросите новую у менеджера.');
  let data;
  try {
    const res = await fetch(`/api/offers/${TOKEN}`);
    data = await res.json();
    if (!res.ok) return fail(data.error || 'Ссылка не найдена.');
  } catch {
    return fail('Не удалось загрузить документ. Проверьте интернет и обновите страницу.');
  }
  state.data = data;
  state.pageAcks = data.pageAcks || {};

  $('docNo').textContent = data.docNumber;
  $('loading').hidden = true;
  const footer = footerHtml(data.company);
  ['footer', 'footer2', 'footer3'].forEach((id) => { $(id).innerHTML = footer; });

  if (data.status === 'signed') return showDone(data);
  if (data.status === 'cancelled') return fail('Эта ссылка отменена. Обратитесь к менеджеру.');

  renderIntro();
  updateProgress();
  return undefined;
}

function fail(message) {
  $('loading').innerHTML = `<div class="wrap"><div class="msg error show">${esc(message)}</div></div>`;
  $('loading').hidden = false;
}

function footerHtml(c) {
  return `${esc(c.legalName)} · ИНН ${esc(c.inn)} · ${esc(c.address)}<br />${esc(c.phone)} · ${esc(c.email)} · ${esc(c.site)}`;
}

function show(id) {
  ['intro', 'viewer', 'signScreen', 'doneScreen'].forEach((s) => { $(s).hidden = s !== id; });
  window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------------ старт

function renderIntro() {
  const d = state.data;
  $('docTitle').textContent = d.docTitle;
  $('introLead').textContent = d.clientHint
    ? `Документ подготовлен для: ${d.clientHint}. Ознакомление и подпись займут несколько минут, регистрироваться не нужно.`
    : 'Ознакомление и подпись займут несколько минут, регистрироваться не нужно.';
  $('introCards').innerHTML = [
    ['Компания', d.company.legalName],
    ['Документ', d.docNumber],
    ['Страниц', String(d.pageCount)],
  ].map(([k, v]) => `<div class="sum-card"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  const done = acked();
  if (done >= total()) $('startBtn').textContent = 'Перейти к подписанию';
  else if (done > 0) $('startBtn').textContent = `Продолжить со страницы ${done + 1}`;
  $('startBtn').onclick = start;
  show('intro');
}

async function start() {
  if (acked() >= total()) return openSign();
  show('viewer');
  $('ackTotal').textContent = total();
  if (!state.pdf) {
    $('paperLoading').hidden = false;
    try {
      state.pdf = await pdfjsLib.getDocument({
        url: state.data.sourcePdfUrl,
        cMapUrl: '/vendor/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      }).promise;
    } catch {
      $('paperLoading').textContent = 'Не удалось загрузить документ. Обновите страницу.';
      return undefined;
    }
  }
  return goTo(Math.min(acked() + 1, total()));
}

// ------------------------------------------------------------------ страницы

async function goTo(n) {
  if (n < 1 || n > total() || n > acked() + 1) return;
  state.page = n;
  clearTimeout(state.unlockTimer);
  $('pageLabel').textContent = `Страница ${n} из ${total()}`;
  $('pageError').classList.remove('show');
  renderStrip();
  renderAck('loading');
  updateNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const rendered = await renderPage(n);
  if (!rendered || state.page !== n) return;

  if (isAcked(n)) return renderAck('done');

  // Сервер фиксирует «просмотрел страницу» и не примет отметку раньше, чем через секунду.
  fetch(`/api/offers/${TOKEN}/pages/${n}/view`, { method: 'POST' }).catch(() => {});
  renderAck('wait');
  state.unlockTimer = setTimeout(() => { if (state.page === n && !isAcked(n)) renderAck('open'); }, READ_DELAY_MS);
}

async function renderPage(n) {
  const canvas = $('pageCanvas');
  $('paperLoading').hidden = false;
  if (state.renderTask) { state.renderTask.cancel(); state.renderTask = null; }
  try {
    const page = await state.pdf.getPage(n);
    const zoom = ZOOMS[state.zoomIdx];
    const base = page.getViewport({ scale: 1 });
    const cssWidth = Math.min($('paperScroll').clientWidth, 900) * zoom;
    const viewport = page.getViewport({ scale: cssWidth / base.width });
    // Рисуем с запасом по плотности, чтобы текст оставался чётким при увеличении пальцами.
    const ratio = Math.min((window.devicePixelRatio || 1) * 1.5, 3, 3000 / viewport.width);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    // В процентах, а не в пикселях: после отрисовки у страницы появляется вертикальная полоса прокрутки,
    // контейнер сужается, и пиксельная ширина давала лишнюю горизонтальную прокрутку.
    $('paper').style.width = `min(${zoom * 100}%, ${900 * zoom}px)`;
    state.renderTask = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
    await state.renderTask.promise;
    state.renderTask = null;
    $('paperLoading').hidden = true;
    return true;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return false;
    $('paperLoading').textContent = 'Не удалось показать страницу. Обновите страницу браузера.';
    return false;
  }
}

function renderStrip() {
  const n = total();
  $('pagesStrip').hidden = n > 40;
  if (n > 40) return;
  $('pagesStrip').innerHTML = Array.from({ length: n }, (_, i) => {
    const p = i + 1;
    const cls = [isAcked(p) ? 'acked' : '', p === state.page ? 'current' : ''].join(' ').trim();
    const locked = p > acked() + 1;
    return `<button type="button" class="${cls}" data-page="${p}" ${locked ? 'disabled' : ''} title="${locked ? 'Сначала подтвердите предыдущие страницы' : `Страница ${p}`}">${p}</button>`;
  }).join('');
  $('pagesStrip').querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => goTo(Number(b.dataset.page))));
}

// mode: loading | wait | open | done
function renderAck(mode) {
  const label = $('pageAck');
  const input = $('pageAckInput');
  const n = state.page;
  label.classList.toggle('locked', mode === 'loading' || mode === 'wait');
  label.classList.toggle('checked', mode === 'done');
  label.classList.toggle('done-ack', mode === 'done');
  input.checked = mode === 'done';
  input.disabled = mode !== 'open';
  $('pageAckNote').textContent = mode === 'loading' ? 'Загружаем страницу…' : 'Просмотрите страницу — отметка станет доступна через пару секунд';
  $('pageAckTime').textContent = mode === 'done' ? `Подтверждено ${fmtTime(state.pageAcks[String(n)])}` : '';
  updateNav();
}

$('pageAckInput').addEventListener('change', async () => {
  const input = $('pageAckInput');
  if (!input.checked) return;
  const n = state.page;
  input.disabled = true;
  try {
    const res = await fetch(`/api/offers/${TOKEN}/pages/${n}/ack`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не удалось сохранить отметку');
    state.pageAcks = data.pageAcks;
    renderAck('done');
    renderStrip();
    updateProgress();
  } catch (e) {
    input.checked = false;
    input.disabled = false;
    $('pageError').textContent = `${e.message}. Попробуйте ещё раз.`;
    $('pageError').classList.add('show');
  }
});

function updateNav() {
  const n = state.page;
  $('prevBtn').disabled = n <= 1;
  const last = n >= total();
  $('nextBtn').textContent = last ? 'Перейти к подписанию' : 'Следующая страница';
  $('nextBtn').disabled = !isAcked(n);
}

$('prevBtn').addEventListener('click', () => goTo(state.page - 1));
$('nextBtn').addEventListener('click', () => {
  if (!isAcked(state.page)) return;
  if (state.page >= total()) openSign();
  else goTo(state.page + 1);
});

function setZoom(delta) {
  state.zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, state.zoomIdx + delta));
  $('zoomLabel').textContent = `${Math.round(ZOOMS[state.zoomIdx] * 100)}%`;
  $('zoomOut').disabled = state.zoomIdx === 0;
  $('zoomIn').disabled = state.zoomIdx === ZOOMS.length - 1;
  renderPage(state.page);
}
$('zoomIn').addEventListener('click', () => setZoom(1));
$('zoomOut').addEventListener('click', () => setZoom(-1));
$('zoomOut').disabled = true;

let resizeTimer = null;
window.addEventListener('resize', () => {
  if ($('viewer').hidden) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPage(state.page), 250);
});

function updateProgress() {
  const t = total();
  $('ackCount').textContent = acked();
  $('progressBar').style.width = `${Math.round((acked() / t) * 90)}%`;
}

// ------------------------------------------------------------------ подписание

let signWired = false;

function openSign() {
  show('signScreen');
  $('finalAckText').textContent = state.data.finalAckText;
  if (!signWired) {
    signWired = true;
    if (state.data.phoneHint && !$('phone').value) $('phone').value = state.data.phoneHint;
    wireSignaturePad();
    wireForm();
  }
  updateSubmit();
}

$('backToDoc').addEventListener('click', () => {
  show('viewer');
  goTo(Math.min(state.page, total()));
});

function wireSignaturePad() {
  const canvas = $('canvas');
  const pad = $('signPad');
  const ctx = canvas.getContext('2d');
  const MIN_INK = 90;          // минимальная длина росчерка в px — защита от «подписи одной точкой»
  let drawing = false;
  let strokes = 0;
  let ink = 0;
  let last = null;

  let retries = 0;
  const resize = () => {
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1) {                    // блок ещё не отрисован — ждём кадр
      if (retries < 60) { retries += 1; requestAnimationFrame(resize); }
      return;
    }
    const data = strokes ? canvas.toDataURL() : null;
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#01182d';
    if (data) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = data;
    }
  };
  resize();
  window.addEventListener('resize', resize);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    strokes += 1;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = pos(e);
    last = { x, y };
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y);
    ctx.stroke();
    pad.classList.add('filled');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const { x, y } = pos(e);
    ink += Math.hypot(x - last.x, y - last.y);
    last = { x, y };
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!state.hasSignature && ink >= MIN_INK) {
      state.hasSignature = true;
      updateSubmit();
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => canvas.addEventListener(ev, () => {
    if (drawing && state.hasSignature) state.signatureDrawnAt = new Date().toISOString();
    drawing = false;
  }));

  $('clearSign').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes = 0;
    ink = 0;
    state.hasSignature = false;
    state.signatureDrawnAt = null;
    pad.classList.remove('filled');
    updateSubmit();
  });

  state.getSignature = () => (state.hasSignature ? canvas.toDataURL('image/png') : '');
}

const cleanName = () => $('fullName').value.trim().replace(/\s+/g, ' ');
const nameOk = (v) => v.length >= 5 && v.split(' ').length >= 2;
const phoneOk = (v) => !v || /^\+?[\d\s()-]{9,20}$/.test(v);

function wireForm() {
  $('fullName').addEventListener('input', () => {
    $('f-fullName').classList.remove('show-err');
    $('fullName').classList.remove('bad');
    updateSubmit();
  });
  $('fullName').addEventListener('change', () => {
    if (nameOk(cleanName())) state.nameEnteredAt = new Date().toISOString();
  });
  $('phone').addEventListener('input', () => { $('f-phone').classList.remove('show-err'); $('phone').classList.remove('bad'); });
  $('finalAckInput').addEventListener('change', () => {
    state.finalAckAt = $('finalAckInput').checked ? new Date().toISOString() : null;
    $('finalAck').classList.toggle('checked', $('finalAckInput').checked);
    updateSubmit();
  });
  $('submitBtn').addEventListener('click', submit);
}

function updateSubmit() {
  const need = [];
  if (!nameOk(cleanName())) need.push('укажите ФИО');
  if (!state.hasSignature) need.push('распишитесь в поле для подписи');
  if (!$('finalAckInput').checked) need.push('отметьте согласие с условиями');
  $('submitBtn').disabled = need.length > 0;
  $('submitHint').textContent = need.length ? `Чтобы подписать: ${need.join(', ')}.` : '';
  $('progressBar').style.width = need.length ? '90%' : '96%';
}

async function submit() {
  const err = $('formError');
  err.classList.remove('show');
  const fullName = cleanName();
  const phone = $('phone').value.trim();

  let ok = true;
  if (!nameOk(fullName)) { $('f-fullName').classList.add('show-err'); $('fullName').classList.add('bad'); ok = false; }
  if (!phoneOk(phone)) { $('f-phone').classList.add('show-err'); $('phone').classList.add('bad'); ok = false; }
  if (!ok) {
    err.textContent = 'Проверьте выделенные поля.';
    err.classList.add('show');
    return;
  }

  const signatureImage = state.getSignature();
  if (!/^data:image\/png;base64,/.test(signatureImage) || signatureImage.length < 500) {
    err.textContent = 'Подпись не сохранилась. Нажмите «Очистить» и распишитесь ещё раз.';
    err.classList.add('show');
    return;
  }

  const btn = $('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Формируем подписанный документ…';
  try {
    const res = await fetch(`/api/offers/${TOKEN}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName,
        phone: phone || null,
        signatureImage,
        finalAck: true,
        finalAckAt: state.finalAckAt,
        nameEnteredAt: state.nameEnteredAt || new Date().toISOString(),
        signatureDrawnAt: state.signatureDrawnAt,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не удалось подписать');
    showDone({ ...state.data, signedAt: data.signedAt, signedName: fullName, documentHash: data.documentHash, pdfUrl: data.pdfUrl, docNumber: data.docNumber });
  } catch (e) {
    err.textContent = e.message;
    err.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Подписать документ';
  }
}

// ------------------------------------------------------------------ готово

function showDone(d) {
  show('doneScreen');
  $('docNo').textContent = d.docNumber;
  $('progressBar').style.width = '100%';
  $('pdfLink').href = d.pdfUrl;
  $('pdfLink').setAttribute('download', '');
  const dt = d.signedAt ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(d.signedAt)) : '—';
  $('doneMeta').innerHTML = [
    ['Документ', d.docTitle],
    ['Номер', d.docNumber],
    d.signedName ? ['Подписал(а)', d.signedName] : null,
    ['Дата подписания', dt],
    d.pageCount ? ['Страниц подтверждено', `${d.pageCount} из ${d.pageCount}`] : null,
    d.documentHash ? ['Хеш подписания', `${d.documentHash.slice(0, 32)}…`] : null,
  ].filter(Boolean).map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
}

boot();
