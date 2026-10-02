'use strict';

/**
 * Сквозной тест: поднимает сервер, создаёт ссылку, подписывает оферту,
 * скачивает PDF и проверяет ключевые правила (повторная подпись, обязательные отметки).
 *   npm test
 */

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const fs = require('fs');
const assert = require('assert');

const PORT = 4099;
const ADMIN = 'test-token';
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = path.join(os.tmpdir(), `elite-offer-test-${crypto.randomBytes(4).toString('hex')}`);

// --- минимальный валидный PNG (для имитации подписи) ---
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x += 1) {
      // «Росчерк»: шумная кривая, чтобы PNG был сопоставим по размеру с реальной подписью.
      const ink = Math.abs(y - (h / 2 + Math.sin(x / 9) * h * 0.3)) < 3 ? crypto.randomInt(0, 60) : 255;
      raw[off + 1 + x * 3] = ink; raw[off + 2 + x * 3] = ink; raw[off + 3 + x * 3] = ink;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const api = async (url, options = {}) => {
  const res = await fetch(BASE + url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`); };

async function run() {
  const created = await api('/api/admin/offers', {
    method: 'POST',
    headers: { 'x-admin-token': ADMIN },
    body: JSON.stringify({ clientName: 'Тестов Тест Тестович', phone: '+996700112233', createdBy: 'Эрбол', bookingDays: 10 }),
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const offer = created.body.offer;
  assert.match(offer.docNumber, /^EA-BR-\d{6}-\d{4}$/);
  assert.strictEqual(offer.params.bookingDays, 10);
  assert.match(created.body.whatsappText, /Тестов Тест Тестович/);
  ok('менеджер создаёт персональную ссылку с индивидуальными условиями');

  const noAuth = await api('/api/admin/offers', { method: 'POST', body: '{}' });
  assert.strictEqual(noAuth.status, 401);
  ok('без токена ссылку создать нельзя');

  const view = await api(`/api/offers/${offer.token}`);
  assert.strictEqual(view.status, 200);
  const doc = view.body.document;
  assert.ok(doc.sections.length >= 12, 'разделов оферты меньше ожидаемого');
  assert.ok(doc.acks.length >= 8, 'отметок меньше ожидаемого');
  assert.match(JSON.stringify(doc), /не подлежит/);
  assert.match(JSON.stringify(doc), /10 календарных дней/);
  ok(`клиент видит оферту: ${doc.sections.length} разделов, ${doc.acks.length} обязательных отметок`);

  const acks = {};
  doc.acks.forEach((a, i) => { acks[a.id] = new Date(Date.now() - (doc.acks.length - i) * 20000).toISOString(); });
  const client = {
    fullName: 'Тестов Тест Тестович',
    phone: '+996 700 112233',
    docNumber: 'ID1234567',
    birthDate: '2004-05-17',
    email: 'test@example.com',
    typedName: 'Тестов Тест Тестович',
    signatureImage: makePng(220, 70),
    timeOnPageSec: 412,
  };

  const missingAck = await api(`/api/offers/${offer.token}/sign`, {
    method: 'POST',
    body: JSON.stringify({ ...client, acks: { ...acks, [doc.acks[3].id]: undefined } }),
  });
  assert.strictEqual(missingAck.status, 400);
  assert.match(missingAck.body.error, /Не отмечен пункт/);
  ok('без всех отметок подпись отклоняется');

  const wrongName = await api(`/api/offers/${offer.token}/sign`, {
    method: 'POST',
    body: JSON.stringify({ ...client, typedName: 'Кто-то Другой', acks }),
  });
  assert.strictEqual(wrongName.status, 400);
  ok('ФИО в подписи должно совпадать с анкетой');

  const noSig = await api(`/api/offers/${offer.token}/sign`, {
    method: 'POST',
    body: JSON.stringify({ ...client, signatureImage: '', acks }),
  });
  assert.strictEqual(noSig.status, 400);
  ok('без графической подписи подписать нельзя');

  const signed = await api(`/api/offers/${offer.token}/sign`, { method: 'POST', body: JSON.stringify({ ...client, acks }) });
  assert.strictEqual(signed.status, 200, JSON.stringify(signed.body));
  assert.match(signed.body.documentHash, /^[a-f0-9]{64}$/);
  ok(`оферта подписана, хеш ${signed.body.documentHash.slice(0, 16)}…`);

  const again = await api(`/api/offers/${offer.token}/sign`, { method: 'POST', body: JSON.stringify({ ...client, acks }) });
  assert.strictEqual(again.status, 409);
  ok('повторно подписать ту же ссылку нельзя');

  const pdfRes = await fetch(`${BASE}/o/${offer.token}/pdf`);
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');
  assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 40000, `PDF подозрительно мал: ${pdf.length} байт`);
  const pages = Number((pdf.toString('latin1').match(/\/Count (\d+)/) || [])[1]);
  assert.ok(pages >= 5 && pages <= 12, `неожиданное число страниц: ${pages} (пустые страницы?)`);
  const out = path.join(os.tmpdir(), 'elite-offer-sample.pdf');
  fs.writeFileSync(out, pdf);
  ok(`PDF-протокол сформирован (${Math.round(pdf.length / 1024)} КБ) → ${out}`);

  const paid = await api(`/api/admin/offers/${offer.id}/paid`, {
    method: 'POST', headers: { 'x-admin-token': ADMIN }, body: JSON.stringify({ paidAt: '2026-08-01' }),
  });
  assert.strictEqual(paid.status, 200);
  assert.ok(paid.body.offer.bookingDeadline.startsWith('2026-08-11'), paid.body.offer.bookingDeadline);
  ok('после отметки об оплате считается дедлайн брони (10 дней → 11.08.2026)');

  const cancel = await api(`/api/admin/offers/${offer.id}/cancel`, { method: 'POST', headers: { 'x-admin-token': ADMIN } });
  assert.strictEqual(cancel.status, 409);
  ok('подписанную оферту отменить нельзя');
}

// ------------------------------------------------- загруженный Word-документ

function converterAvailable() {
  if (process.env.SOFFICE_DOCKER_IMAGE) return true;
  try {
    execFileSync(process.env.SOFFICE_BIN || 'soffice', ['--version'], { stdio: 'ignore', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadDocx(buffer, name, fields = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  const res = await fetch(`${BASE}/api/admin/docs`, { method: 'POST', headers: { 'x-admin-token': ADMIN }, body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function runDocx() {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.docx'));
  const up = await uploadDocx(fixture, 'Тестовая оферта.docx', { clientName: 'Иванова Айгерим', createdBy: 'Эрбол' });
  assert.strictEqual(up.status, 201, JSON.stringify(up.body));
  const offer = up.body.offer;
  assert.strictEqual(offer.kind, 'docx');
  assert.strictEqual(offer.pageCount, 3);
  assert.strictEqual(offer.docTitle, 'Тестовая оферта');
  assert.strictEqual(offer.stage, 'ready');
  assert.match(offer.docNumber, /^EA-DOC-\d{6}-\d{4}$/);
  ok('менеджер загружает .docx: документ подготовлен, 3 страницы, кириллица в имени файла цела');

  const bad = await uploadDocx(Buffer.from('not a docx'), 'fake.docx');
  assert.strictEqual(bad.status, 400);
  const wrongExt = await uploadDocx(fixture, 'doc.pdf');
  assert.strictEqual(wrongExt.status, 400);
  ok('не-.docx и повреждённые файлы отклоняются');

  const T = offer.token;
  const view = await api(`/api/offers/${T}`);
  assert.strictEqual(view.body.kind, 'docx');
  assert.strictEqual(view.body.pageCount, 3);
  const pdfRes = await fetch(`${BASE}${view.body.sourcePdfUrl}`);
  assert.strictEqual(pdfRes.status, 200);
  assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');
  ok('клиент получает документ и его PDF-версию для постраничного просмотра');

  const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body || {}) });
  assert.strictEqual((await post(`/api/offers/${T}/pages/2/ack`)).status, 409);
  assert.strictEqual((await post(`/api/offers/${T}/pages/3/view`)).status, 409);
  assert.strictEqual((await post(`/api/offers/${T}/pages/1/ack`)).status, 409, 'без просмотра отметка не должна приниматься');
  ok('нельзя перескочить страницу и нельзя отметить страницу, не открыв её');

  const signBody = {
    fullName: 'Иванова Айгерим Маратовна',
    phone: '+996 555 010203',
    signatureImage: makePng(220, 70),
    finalAck: true,
    finalAckAt: new Date().toISOString(),
  };

  assert.strictEqual((await post(`/api/offers/${T}/pages/1/view`)).status, 200);
  await sleep(1100);
  assert.strictEqual((await post(`/api/offers/${T}/pages/1/ack`)).status, 200);
  const early = await post(`/api/offers/${T}/sign`, signBody);
  assert.strictEqual(early.status, 400);
  assert.match(early.body.error, /страницей 2/);
  ok('подписать, не подтвердив все страницы, нельзя');

  for (const n of [2, 3]) {
    assert.strictEqual((await post(`/api/offers/${T}/pages/${n}/view`)).status, 200);
    await sleep(1100);
    const ack = await post(`/api/offers/${T}/pages/${n}/ack`);
    assert.strictEqual(ack.status, 200, JSON.stringify(ack.body));
  }
  const list = await api('/api/admin/offers', { headers: { 'x-admin-token': ADMIN } });
  assert.strictEqual(list.body.offers.find((o) => o.id === offer.id).stage, 'awaiting_signature');
  ok('страницы подтверждаются по порядку, этап в кабинете — «ожидает подписания»');

  assert.strictEqual((await post(`/api/offers/${T}/sign`, { ...signBody, finalAck: false })).status, 400);
  assert.strictEqual((await post(`/api/offers/${T}/sign`, { ...signBody, fullName: 'Айгерим' })).status, 400);
  const signed = await post(`/api/offers/${T}/sign`, signBody);
  assert.strictEqual(signed.status, 200, JSON.stringify(signed.body));
  assert.match(signed.body.documentHash, /^[a-f0-9]{64}$/);
  ok(`документ подписан, хеш ${signed.body.documentHash.slice(0, 16)}…`);

  const again = await post(`/api/offers/${T}/sign`, signBody);
  assert.strictEqual(again.status, 409);
  assert.strictEqual((await post(`/api/offers/${T}/pages/1/ack`)).status, 409);
  ok('подписанный документ нельзя подписать повторно или изменить отметки');

  const final = Buffer.from(await (await fetch(`${BASE}${signed.body.pdfUrl}`)).arrayBuffer());
  const { PDFDocument } = require('pdf-lib');
  const pages = (await PDFDocument.load(final)).getPageCount();
  assert.ok(pages >= 4, `в итоговом PDF ${pages} стр., ожидалось 3 + лист подписания`);
  const out = path.join(os.tmpdir(), 'elite-offer-doc-sample.pdf');
  fs.writeFileSync(out, final);
  ok(`итоговый PDF: 3 стр. документа + ${pages - 3} лист подписания (${Math.round(final.length / 1024)} КБ) → ${out}`);

  const { body: { events } } = await api(`/api/admin/offers/${offer.id}/events`, { headers: { 'x-admin-token': ADMIN } });
  const types = events.map((e) => e.type);
  ['created', 'uploaded', 'converted', 'opened', 'page_viewed', 'page_acked', 'name_entered', 'signature_drawn', 'signed']
    .forEach((t) => assert.ok(types.includes(t), `в журнале нет события ${t}`));
  assert.strictEqual(types.filter((t) => t === 'page_acked').length, 3);
  ok(`журнал действий: ${events.length} событий, все этапы зафиксированы`);

  const src = await fetch(`${BASE}/api/admin/offers/${offer.id}/source.docx`, { headers: { 'x-admin-token': ADMIN } });
  assert.ok(Buffer.from(await src.arrayBuffer()).equals(fixture));
  ok('менеджер скачивает исходный .docx без изменений');
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, DATA_DIR: dataDir, PUBLIC_BASE_URL: BASE },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const wait = async () => {
  // Первый запуск после установки зависимостей бывает медленным (антивирус проверяет node_modules).
  for (let i = 0; i < 300; i += 1) {
    try { await fetch(BASE + '/api/offers/none'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('Сервер не поднялся');
};

(async () => {
  try {
    await wait();
    console.log('\n  Сквозной тест модуля оферты\n');
    await run();
    if (converterAvailable()) {
      console.log('\n  Загруженный Word-документ\n');
      await runDocx();
    } else {
      console.log('\n  ! Сценарий с .docx пропущен: нет LibreOffice (soffice) и не задан SOFFICE_DOCKER_IMAGE');
    }
    console.log(`\n  Все проверки пройдены: ${checks}\n`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n  ОШИБКА:', e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
