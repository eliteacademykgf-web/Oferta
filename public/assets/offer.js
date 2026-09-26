'use strict';

/* Страница подписания оферты. Логика: анкета → чтение разделов → отметки → подпись → PDF. */

const TOKEN = location.pathname.split('/').filter(Boolean)[1] || '';
const CRITICAL = ['no-refund', 'expiry'];      // разделы, которые подсвечиваем как ключевые
const READ_DWELL_MS = 1200;                    // сколько раздел должен быть виден, чтобы считаться прочитанным

const $ = (id) => document.getElementById(id);
const state = {
  doc: null,
  ackTimes: {},          // ackId -> ISO-время отметки
  startedAt: Date.now(),
  hasSignature: false,
};

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

  state.doc = data.document;

  $('docNo').textContent = data.docNumber;
  $('loading').hidden = true;

  if (data.status === 'signed') return showDone({
    docNumber: data.docNumber,
    signedAt: data.signedAt,
    pdfUrl: data.pdfUrl,
    name: data.signedName,
  });
  if (data.status === 'cancelled') return fail('Эта ссылка отменена менеджером. Запросите новую.');

  // Страницу показываем ДО отрисовки: элементы скрытого блока имеют нулевые размеры,
  // и холст для подписи получил бы размер 0×0 (подпись сохранялась бы пустой).
  $('app').hidden = false;
  render(data);
}

function fail(message) {
  $('loading').innerHTML = `<div class="wrap"><div class="msg error show">${message}</div></div>`;
  $('loading').hidden = false;
}

// ------------------------------------------------------------------ отрисовка

function render(data) {
  const doc = data.document;

  $('heroLead').textContent = data.clientHint
    ? `Документ подготовлен персонально для: ${data.clientHint}. Пожалуйста, прочитайте его полностью — это займёт 5–7 минут.`
    : 'Пожалуйста, прочитайте документ полностью — это займёт 5–7 минут.';

  $('summary').innerHTML = doc.summary.map((s, i) => `
    <div class="sum-card${i === doc.summary.length - 1 ? ' alert' : ''}">
      <b>${esc(s.label)}</b><span>${esc(s.value)}</span>
    </div>`).join('');

  const host = $('sections');
  host.innerHTML = doc.sections.map((s) => {
    const critical = CRITICAL.includes(s.id);
    return `
      <div class="doc-section${critical ? ' critical' : ''}" data-section="${s.id}">
        <h3>${s.no ? `${esc(s.no)}. ` : ''}${esc(s.title)}</h3>
        ${s.blocks.map((b) => `<p>${esc(b)}</p>`).join('')}
        <div class="read-sentinel" data-sentinel="${s.id}" style="height:1px"></div>
        ${s.ack ? ackHtml(s.ack, critical) : ''}
      </div>`;
  }).join('');

  $('finalAckHolder').innerHTML = ackHtml(doc.finalAck, true, true);
  $('ackTotal').textContent = doc.acks.length;
  $('footer').innerHTML = $('footer2').innerHTML = footerHtml(data.company, doc);

  wireAcks();
  wireReadingGate();
  wireSignaturePad();
  wireForm();
  updateProgress();
}

function ackHtml(ack, critical, unlocked) {
  return `
    <label class="ack${critical ? ' critical' : ''}${unlocked ? '' : ' locked'}" data-ack="${ack.id}">
      <input type="checkbox" data-ack-input="${ack.id}" ${unlocked ? '' : 'disabled'} />
      <span>
        <span class="ack-text">${esc(ack.text)}</span>
        <span class="lock-note">Дочитайте раздел до конца, чтобы поставить отметку</span>
      </span>
    </label>`;
}

function footerHtml(company, doc) {
  return `${esc(company.legalName)} · ИНН ${esc(company.inn)} · ${esc(company.address)}<br />
    ${esc(company.phone)} · ${esc(company.email)} · ${esc(company.site)}<br />
    Редакция оферты ${esc(doc.version)} от ${esc(doc.versionDate)}`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------- «прочитано» → разблокировка

function wireReadingGate() {
  // Намеренно на getBoundingClientRect, а не на IntersectionObserver: IO не срабатывает
  // в фоновых/невидимых вкладках и в части встроенных браузеров (WhatsApp, Instagram),
  // а там отметки остались бы заблокированными навсегда и клиент не смог бы подписать.
  const pending = new Map();   // id -> момент, когда раздел впервые оказался прочитанным
  const sentinels = [...document.querySelectorAll('[data-sentinel]')];

  const check = () => {
    const limit = window.innerHeight - 40;
    const now = Date.now();
    for (let i = sentinels.length - 1; i >= 0; i -= 1) {
      const el = sentinels[i];
      const id = el.dataset.sentinel;
      if (el.getBoundingClientRect().top > limit) continue;   // раздел ещё не дочитан
      if (!pending.has(id)) { pending.set(id, now); continue; }
      if (now - pending.get(id) < READ_DWELL_MS) continue;
      unlockSection(id);
      sentinels.splice(i, 1);
    }
    if (!sentinels.length) {
      window.removeEventListener('scroll', check);
      clearInterval(ticker);
    }
  };

  const ticker = setInterval(check, 400);
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check, { passive: true });
  check();
}

function unlockSection(id) {
  const section = document.querySelector(`[data-section="${id}"]`);
  const label = section && section.querySelector('.ack');
  if (!label) return;
  label.classList.remove('locked');
  label.querySelector('input').disabled = false;
}

// ------------------------------------------------------------------ отметки

function wireAcks() {
  document.querySelectorAll('[data-ack-input]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.ackInput;
      const label = input.closest('.ack');
      if (input.checked) {
        state.ackTimes[id] = new Date().toISOString();
        label.classList.add('checked');
      } else {
        delete state.ackTimes[id];
        label.classList.remove('checked');
      }
      updateProgress();
    });
  });
}

function updateProgress() {
  const total = state.doc.acks.length;
  const done = Object.keys(state.ackTimes).length;
  $('ackCount').textContent = done;
  $('progressBar').style.width = `${Math.round((done / total) * 100)}%`;
  $('submitBtn').disabled = done < total || !state.hasSignature;
  $('jumpBtn').textContent = done < total ? 'К следующей отметке' : 'К подписи';

  const need = [];
  if (done < total) need.push(`отметьте все пункты (осталось ${total - done})`);
  if (!state.hasSignature) need.push('распишитесь в поле для подписи');
  $('submitHint').textContent = need.length ? `Чтобы подписать: ${need.join(', ')}.` : '';
}

$('jumpBtn').addEventListener('click', () => {
  const next = [...document.querySelectorAll('[data-ack-input]')].find((i) => !i.checked);
  const target = next ? next.closest('.ack') : $('signStep');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ------------------------------------------------------------------ подпись

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
      updateProgress();
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => canvas.addEventListener(ev, () => { drawing = false; }));

  $('clearSign').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes = 0;
    ink = 0;
    state.hasSignature = false;
    pad.classList.remove('filled');
    updateProgress();
  });

  state.getSignature = () => (state.hasSignature ? canvas.toDataURL('image/png') : '');
}

// ------------------------------------------------------------------ отправка

function wireForm() {
  ['fullName', 'phone', 'docNumber', 'birthDate', 'email', 'typedName'].forEach((id) => {
    $(id).addEventListener('input', () => $(`f-${id}`).classList.remove('show-err'));
  });
  // Автоподстановка ФИО в поле подписи по первому вводу.
  $('typedName').addEventListener('focus', () => {
    if (!$('typedName').value) $('typedName').value = $('fullName').value;
  });
  $('submitBtn').addEventListener('click', submit);
}

function markBad(id, on) {
  $(`f-${id}`).classList.toggle('show-err', on);
  $(id).classList.toggle('bad', on);
  return !on;
}

function validate() {
  const norm = (v) => v.trim().toLowerCase().replace(/ё/g, 'е');
  const fullName = $('fullName').value.trim().replace(/\s+/g, ' ');
  let ok = true;
  ok = markBad('fullName', !(fullName.length >= 5 && fullName.split(' ').length >= 2)) && ok;
  ok = markBad('phone', !/^\+?[\d\s()-]{9,20}$/.test($('phone').value.trim())) && ok;
  ok = markBad('docNumber', $('docNumber').value.trim().length < 4) && ok;
  ok = markBad('email', !!$('email').value.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test($('email').value.trim())) && ok;
  ok = markBad('typedName', norm($('typedName').value) !== norm(fullName) || !fullName) && ok;
  return ok;
}

async function submit() {
  const btn = $('submitBtn');
  const err = $('formError');
  err.classList.remove('show');

  if (!validate()) {
    err.textContent = 'Проверьте выделенные поля в анкете и в блоке подписи.';
    err.classList.add('show');
    document.querySelector('.field.show-err').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (Object.keys(state.ackTimes).length < state.doc.acks.length) {
    err.textContent = 'Отметьте все пункты — они обязательны.';
    err.classList.add('show');
    return;
  }

  const signatureImage = state.getSignature();
  if (!/^data:image\/png;base64,/.test(signatureImage) || signatureImage.length < 500) {
    err.textContent = 'Подпись не сохранилась. Нажмите «Очистить» и распишитесь ещё раз.';
    err.classList.add('show');
    $('signPad').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Формируем документ…';

  const payload = {
    fullName: $('fullName').value.trim().replace(/\s+/g, ' '),
    phone: $('phone').value.trim(),
    docNumber: $('docNumber').value.trim(),
    birthDate: $('birthDate').value || null,
    email: $('email').value.trim() || null,
    typedName: $('typedName').value.trim().replace(/\s+/g, ' '),
    acks: state.ackTimes,
    signatureImage,
    timeOnPageSec: Math.round((Date.now() - state.startedAt) / 1000),
  };

  try {
    const res = await fetch(`/api/offers/${TOKEN}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не удалось подписать');
    showDone({ docNumber: data.docNumber, signedAt: data.signedAt, pdfUrl: data.pdfUrl, hash: data.documentHash, name: payload.fullName });
  } catch (e) {
    err.textContent = e.message;
    err.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Подписать оферту';
  }
}

// ------------------------------------------------------------- финальный экран

function showDone({ docNumber, signedAt, pdfUrl, hash, name }) {
  $('app').hidden = true;
  $('loading').hidden = true;
  $('doneScreen').hidden = false;
  $('docNo').textContent = docNumber;
  $('progressBar').style.width = '100%';
  $('pdfLink').href = pdfUrl;
  $('pdfLink').setAttribute('download', '');
  const dt = signedAt ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(signedAt)) : '—';
  $('doneMeta').innerHTML = `
    <div><span>Документ</span><span>${esc(docNumber)}</span></div>
    ${name ? `<div><span>Подписал(а)</span><span>${esc(name)}</span></div>` : ''}
    <div><span>Дата подписания</span><span>${esc(dt)}</span></div>
    ${hash ? `<div><span>Хеш документа</span><span>${esc(hash.slice(0, 32))}…</span></div>` : ''}`;
  if ($('footer2') && !$('footer2').innerHTML && state.doc) {
    $('footer2').innerHTML = $('footer').innerHTML;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

boot();
