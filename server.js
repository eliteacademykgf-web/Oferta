'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');

const config = require('./src/config');
const store = require('./src/store');
const { buildOffer, OFFER_VERSION } = require('./src/offer-text');
const { renderProtocol } = require('./src/pdf');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : true);
app.use(express.json({ limit: '4mb' }));

// ---------------------------------------------------------------- утилиты

const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.admin_token || '';
  if (!token || !safeEqual(token, config.adminToken)) {
    return res.status(401).json({ error: 'Неверный токен доступа' });
  }
  return next();
}

// Простой лимитер попыток (в памяти). При переезде на сервер заменить на Redis.
const attempts = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.reset) {
    attempts.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  rec.count += 1;
  return rec.count <= max;
}

function dealParams(override = {}) {
  const d = config.defaults;
  const pick = (name, fallback) => {
    const v = override[name];
    if (v === undefined || v === null || v === '') return fallback;
    return typeof fallback === 'number' ? Number(v) : v;
  };
  return {
    packageName: pick('packageName', d.packageName),
    bookingFee: pick('bookingFee', d.bookingFee),
    currency: pick('currency', d.currency),
    discountUsd: pick('discountUsd', d.discountUsd),
    secondTrancheMin: pick('secondTrancheMin', d.secondTrancheMin),
    secondTrancheMax: pick('secondTrancheMax', d.secondTrancheMax),
    bookingDays: pick('bookingDays', d.bookingDays),
    payWindowHours: pick('payWindowHours', d.payWindowHours),
    extensionDays: pick('extensionDays', d.extensionDays),
    refundWorkDays: pick('refundWorkDays', d.refundWorkDays),
    claimDays: pick('claimDays', d.claimDays),
    dataRetentionYears: pick('dataRetentionYears', d.dataRetentionYears),
  };
}

function docNumberFor(index, date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `EA-BR-${y}${m}-${String(index).padStart(4, '0')}`;
}

const publicView = (offer) => ({
  id: offer.id,
  token: offer.token,
  docNumber: offer.docNumber,
  status: offer.status,
  createdAt: offer.createdAt,
  createdBy: offer.createdBy,
  clientHint: offer.clientHint,
  phoneHint: offer.phoneHint,
  note: offer.note,
  params: offer.params,
  firstOpenedAt: offer.firstOpenedAt,
  opens: offer.opens ? offer.opens.length : 0,
  signedAt: offer.signature ? offer.signature.signedAt : null,
  signedName: offer.signature ? offer.signature.fullName : null,
  signedPhone: offer.signature ? offer.signature.phone : null,
  paidAt: offer.paidAt || null,
  bookingDeadline: offer.bookingDeadline || null,
  documentHash: offer.documentHash || null,
  url: `${config.publicBaseUrl}/o/${offer.token}`,
  pdfUrl: offer.status === 'signed' ? `${config.publicBaseUrl}/o/${offer.token}/pdf` : null,
});

// ---------------------------------------------------------- админ-API (менеджер)

app.post('/api/admin/offers', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const now = new Date();
  const index = store.listOffers().length + 1;
  const offer = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(16).toString('hex'),
    docNumber: docNumberFor(index, now),
    status: 'draft',
    createdAt: now.toISOString(),
    createdBy: (b.createdBy || '').toString().trim().slice(0, 80) || 'менеджер',
    clientHint: (b.clientName || '').toString().trim().slice(0, 120),
    phoneHint: (b.phone || '').toString().trim().slice(0, 32),
    note: (b.note || '').toString().trim().slice(0, 500),
    offerVersion: OFFER_VERSION,
    params: dealParams(b),
    opens: [],
    firstOpenedAt: null,
    signature: null,
  };
  await store.createOffer(offer);
  res.status(201).json({ offer: publicView(offer), whatsappText: whatsappText(offer) });
});

app.get('/api/admin/offers', requireAdmin, (req, res) => {
  res.json({ offers: store.listOffers().map(publicView) });
});

app.post('/api/admin/offers/:id/cancel', requireAdmin, async (req, res) => {
  const offer = store.findById(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Не найдено' });
  if (offer.status === 'signed') return res.status(409).json({ error: 'Подписанную оферту нельзя отменить' });
  await store.updateOffer(offer.id, { status: 'cancelled' });
  res.json({ offer: publicView(store.findById(offer.id)) });
});

// Менеджер отмечает поступление первого транша → считается дата окончания брони.
app.post('/api/admin/offers/:id/paid', requireAdmin, async (req, res) => {
  const offer = store.findById(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Не найдено' });
  if (offer.status !== 'signed') return res.status(409).json({ error: 'Сначала клиент должен подписать оферту' });
  const paidAt = req.body && req.body.paidAt ? new Date(req.body.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime())) return res.status(400).json({ error: 'Некорректная дата оплаты' });
  const deadline = new Date(paidAt.getTime() + offer.params.bookingDays * 86400000);
  await store.updateOffer(offer.id, { paidAt: paidAt.toISOString(), bookingDeadline: deadline.toISOString() });
  res.json({ offer: publicView(store.findById(offer.id)) });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({ defaults: config.defaults, company: config.company, offerVersion: OFFER_VERSION });
});

function whatsappText(offer) {
  const name = offer.clientHint ? `${offer.clientHint}, ` : '';
  return `${name}здравствуйте! Это ${config.company.brand}.\n\n`
    + `Перед бронированием места, пожалуйста, ознакомьтесь с офертой по ссылке — там подробно описано, что вы бронируете, на какой срок и на каких условиях:\n`
    + `${config.publicBaseUrl}/o/${offer.token}\n\n`
    + `Ссылка персональная. После подписания вам придёт PDF-документ — пришлите его мне сюда, и я отправлю реквизиты для оплаты брони.`;
}

// ------------------------------------------------------------- публичное API

app.get('/api/offers/:token', async (req, res) => {
  const offer = store.findByToken(req.params.token);
  if (!offer) return res.status(404).json({ error: 'Ссылка не найдена или устарела' });

  if (offer.status === 'draft') {
    const opens = offer.opens || [];
    if (opens.length < 50) {
      opens.push({ at: new Date().toISOString(), ip: clientIp(req), ua: (req.get('user-agent') || '').slice(0, 250) });
    }
    await store.updateOffer(offer.id, { opens, firstOpenedAt: offer.firstOpenedAt || new Date().toISOString() });
  }

  res.json({
    status: offer.status,
    docNumber: offer.docNumber,
    clientHint: offer.clientHint,
    phoneHint: offer.phoneHint,
    params: offer.params,
    company: config.company,
    document: buildOffer(offer.params, config.company),
    signedAt: offer.signature ? offer.signature.signedAt : null,
    signedName: offer.signature ? offer.signature.fullName : null,
    pdfUrl: offer.status === 'signed' ? `/o/${offer.token}/pdf` : null,
  });
});

function validateSignature(body, document) {
  const errors = [];
  const s = {};

  s.fullName = (body.fullName || '').toString().trim().replace(/\s+/g, ' ');
  if (s.fullName.length < 5 || s.fullName.split(' ').length < 2) errors.push('Укажите фамилию и имя полностью');
  if (s.fullName.length > 120) errors.push('Слишком длинное ФИО');

  s.phone = (body.phone || '').toString().trim();
  if (!/^\+?[\d\s()-]{9,20}$/.test(s.phone)) errors.push('Укажите корректный номер телефона');

  s.docNumber = (body.docNumber || '').toString().trim().slice(0, 40);
  if (s.docNumber.length < 4) errors.push('Укажите номер паспорта или ID');

  s.birthDate = (body.birthDate || '').toString().trim() || null;
  if (s.birthDate && Number.isNaN(new Date(s.birthDate).getTime())) errors.push('Некорректная дата рождения');

  s.email = (body.email || '').toString().trim().slice(0, 120) || null;
  if (s.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) errors.push('Некорректный e-mail');

  s.typedName = (body.typedName || '').toString().trim().replace(/\s+/g, ' ');
  const norm = (v) => v.toLowerCase().replace(/ё/g, 'е');
  if (norm(s.typedName) !== norm(s.fullName)) errors.push('Введённое для подписи ФИО должно совпадать с ФИО из анкеты');

  const acks = body.acks && typeof body.acks === 'object' ? body.acks : {};
  s.acks = {};
  document.acks.forEach((ack) => {
    const at = acks[ack.id];
    if (!at || Number.isNaN(new Date(at).getTime())) {
      errors.push(`Не отмечен пункт: «${ack.text.slice(0, 60)}…»`);
      return;
    }
    s.acks[ack.id] = new Date(at).toISOString();
  });

  s.signatureImage = (body.signatureImage || '').toString();
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s.signatureImage)) {
    errors.push('Поставьте подпись в поле для подписи');
  } else if (s.signatureImage.length < 500) {
    errors.push('Подпись слишком короткая — распишитесь ещё раз');
  } else if (s.signatureImage.length > 2_000_000) {
    errors.push('Изображение подписи слишком большое');
  }

  s.timeOnPageSec = Math.max(0, Math.min(86400, Number(body.timeOnPageSec) || 0));

  return { errors, signature: s };
}

app.post('/api/offers/:token/sign', async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit(`sign:${ip}`, 20, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через несколько минут.' });
  }

  const offer = store.findByToken(req.params.token);
  if (!offer) return res.status(404).json({ error: 'Ссылка не найдена или устарела' });
  if (offer.status === 'signed') return res.status(409).json({ error: 'Эта оферта уже подписана' });
  if (offer.status === 'cancelled') return res.status(409).json({ error: 'Ссылка отменена. Обратитесь к менеджеру.' });

  const document = buildOffer(offer.params, config.company);
  const { errors, signature } = validateSignature(req.body || {}, document);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  signature.signedAt = new Date().toISOString();
  signature.ip = ip;
  signature.userAgent = (req.get('user-agent') || '').slice(0, 250);

  // Хеш считается от текста оферты + данных акцепта: доказательство неизменности.
  const hashSource = JSON.stringify({
    version: document.version,
    title: document.title,
    sections: document.sections,
    finalAck: document.finalAck,
    params: offer.params,
    docNumber: offer.docNumber,
    client: {
      fullName: signature.fullName,
      phone: signature.phone,
      docNumber: signature.docNumber,
      birthDate: signature.birthDate,
      email: signature.email,
    },
    acks: signature.acks,
    signedAt: signature.signedAt,
  });
  const documentHash = sha256(hashSource);

  const patched = await store.updateOffer(offer.id, {
    status: 'signed',
    signature,
    documentHash,
    offerVersion: document.version,
  });

  try {
    const pdf = await renderProtocol(patched, document);
    await fsp.writeFile(store.pdfPath(patched), pdf);
  } catch (err) {
    console.error('[pdf] не удалось сформировать протокол:', err);
    return res.status(500).json({ error: 'Подпись сохранена, но PDF не сформировался. Свяжитесь с менеджером.' });
  }

  res.json({
    ok: true,
    docNumber: patched.docNumber,
    signedAt: signature.signedAt,
    documentHash,
    pdfUrl: `/o/${offer.token}/pdf`,
  });
});

app.get('/o/:token/pdf', async (req, res) => {
  const offer = store.findByToken(req.params.token);
  if (!offer || offer.status !== 'signed') return res.status(404).send('Документ не найден');
  const file = store.pdfPath(offer);
  if (!fs.existsSync(file)) {
    // Восстанавливаем PDF из данных, если файл потерялся.
    const pdf = await renderProtocol(offer, buildOffer(offer.params, config.company));
    await fsp.writeFile(file, pdf);
  }
  const human = `Oferta_bronirovanie_${offer.docNumber}.pdf`;
  // ?inline=1 — открыть в браузере вместо скачивания (удобно менеджеру для быстрого просмотра).
  const disposition = req.query.inline ? 'inline' : 'attachment';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${human}"; filename*=UTF-8''${encodeURIComponent(`Оферта_бронирование_${offer.docNumber}.pdf`)}`);
  fs.createReadStream(file).pipe(res);
});

// Проверка живости для хостинга (Railway healthcheck).
app.get('/healthz', (req, res) => {
  res.json({ ok: true, offerVersion: OFFER_VERSION, offers: store.listOffers().length });
});

// ----------------------------------------------------------------- страницы

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/o/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'offer.html'));
});

app.get('/', (req, res) => res.redirect('/manager.html'));

app.use((req, res) => res.status(404).send('Страница не найдена'));

app.listen(config.port, () => {
  const local = config.publicBaseUrl.includes('localhost');
  console.log(`\n  ${config.company.brand} — модуль оферты`);
  console.log(`  Кабинет менеджера: ${config.publicBaseUrl}/manager.html`);
  console.log(`  Редакция оферты:   ${OFFER_VERSION}`);
  console.log(`  Данные:            ${config.dataDir}`);
  if (config.adminToken === 'change-me-please') {
    console.log('  ВНИМАНИЕ: задайте ADMIN_TOKEN — сейчас используется значение по умолчанию.');
  }
  if (!local && !process.env.DATA_DIR) {
    console.log('  ВНИМАНИЕ: DATA_DIR не задан. На хостинге без подключённого диска подписанные');
    console.log('            документы пропадут при перезапуске контейнера.');
  }
  if (config.company.inn.includes('__')) {
    console.log('  ВНИМАНИЕ: реквизиты компании не заполнены — заглушки попадут в PDF.');
  }
  console.log('');
});
