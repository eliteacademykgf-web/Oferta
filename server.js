'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const multer = require('multer');

const config = require('./src/config');
const store = require('./src/store');
const { buildOffer, OFFER_VERSION } = require('./src/offer-text');
const { renderProtocol, renderDocxProtocol, buildSignedPdf } = require('./src/pdf');
const { convertDocxToPdf, countPages } = require('./src/convert');

const FINAL_ACK_TEXT = 'Я подтверждаю, что ознакомился(ась) со всеми страницами документа, указал(а) достоверные данные и подтверждаю своё согласие с условиями документа.';
const MIN_PAGE_VIEW_MS = 1000;   // сервер не примет отметку страницы раньше, чем через секунду после её открытия
const MAX_EVENTS = 2000;

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

function docNumberFor(index, date, prefix = 'EA-BR') {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${prefix}-${y}${m}-${String(index).padStart(4, '0')}`;
}

const isDocx = (offer) => offer.kind === 'docx';
const ackedCount = (offer) => Object.keys(offer.pageAcks || {}).length;

function newEvent(type, req, extra = {}) {
  const ev = { type, at: new Date().toISOString(), ...extra };
  if (req) {
    ev.ip = clientIp(req);
    ev.ua = (req.get('user-agent') || '').slice(0, 250);
  }
  return ev;
}

function withEvents(offer, ...events) {
  return [...(offer.events || []), ...events].slice(-MAX_EVENTS);
}

// Этап для кабинета считается из статуса и журнала — отдельной ручной стейт-машины нет.
function stageOf(offer) {
  if (offer.status === 'signed') return 'signed';
  if (offer.status === 'cancelled') return 'cancelled';
  if (isDocx(offer) && offer.pageCount && ackedCount(offer) >= offer.pageCount) return 'awaiting_signature';
  if (offer.firstOpenedAt) return 'viewing';
  if (isDocx(offer) && !(offer.events || []).some((e) => e.type === 'sent')) return 'ready';
  return 'sent';
}

// busboy отдаёт имя файла в latin1; если в строке есть символы за пределами latin1 — оно уже раскодировано.
function decodeFilename(name) {
  const raw = String(name || '');
  return /[^\u0000-ÿ]/.test(raw) ? raw : Buffer.from(raw, 'latin1').toString('utf8');
}

function contentDisposition(disposition, asciiName, utf8Name) {
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
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
  kind: isDocx(offer) ? 'docx' : 'text',
  stage: stageOf(offer),
  docTitle: offer.docTitle || null,
  sourceName: offer.source ? offer.source.originalName : null,
  pageCount: offer.pageCount || null,
  pagesAcked: isDocx(offer) ? ackedCount(offer) : null,
  sentAt: ((offer.events || []).find((e) => e.type === 'sent') || {}).at || null,
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
  await store.updateOffer(offer.id, { status: 'cancelled', events: withEvents(offer, newEvent('cancelled')) });
  res.json({ offer: publicView(store.findById(offer.id)) });
});

// ---- загруженные Word-документы

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    const ok = /\.docx$/i.test(decodeFilename(file.originalname));
    cb(ok ? null : new Error('Нужен файл Word в формате .docx (старый .doc сначала пересохраните в Word как .docx)'), ok);
  },
});

const receiveDocx = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 20 МБ' : err.message;
  return res.status(400).json({ error: message });
});

app.post('/api/admin/docs', requireAdmin, receiveDocx, async (req, res) => {
  const file = req.file;
  const b = req.body || {};
  if (!file) return res.status(400).json({ error: 'Выберите файл .docx' });
  // .docx — это zip-архив: без сигнатуры PK это повреждённый файл или переименованный .doc.
  if (file.buffer.length < 4 || file.buffer.readUInt32BE(0) !== 0x504b0304) {
    return res.status(400).json({ error: 'Файл повреждён или это не .docx. Откройте его в Word и сохраните как «Документ Word (.docx)».' });
  }

  const id = crypto.randomUUID();
  const dir = store.docDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const docxPath = path.join(dir, 'source.docx');
  await fsp.writeFile(docxPath, file.buffer);

  let pdfBuf;
  let pageCount;
  const startedAt = Date.now();
  try {
    pdfBuf = await fsp.readFile(await convertDocxToPdf(docxPath, dir));
    pageCount = await countPages(pdfBuf);
    if (!pageCount) throw new Error('В документе не найдено ни одной страницы');
  } catch (err) {
    console.error('[docx] конвертация не удалась:', err.message);
    await fsp.rm(dir, { recursive: true, force: true });
    return res.status(422).json({ error: err.message });
  }

  const originalName = decodeFilename(file.originalname).slice(0, 200);
  const now = new Date();
  const offer = {
    id,
    kind: 'docx',
    token: crypto.randomBytes(16).toString('hex'),
    docNumber: docNumberFor(store.listOffers().length + 1, now, 'EA-DOC'),
    status: 'draft',
    createdAt: now.toISOString(),
    createdBy: (b.createdBy || '').toString().trim().slice(0, 80) || 'менеджер',
    clientHint: (b.clientName || '').toString().trim().slice(0, 120),
    phoneHint: (b.phone || '').toString().trim().slice(0, 32),
    note: (b.note || '').toString().trim().slice(0, 500),
    docTitle: (b.title || '').toString().trim().slice(0, 160) || path.parse(originalName).name,
    source: {
      originalName,
      size: file.size,
      uploadedAt: now.toISOString(),
      sourceHash: sha256(file.buffer),
      pdfHash: sha256(pdfBuf),
    },
    pageCount,
    pageViews: {},
    pageAcks: {},
    opens: [],
    firstOpenedAt: null,
    signature: null,
    events: [
      newEvent('created', null, { by: (b.createdBy || '').toString().trim().slice(0, 80) || 'менеджер' }),
      newEvent('uploaded', null, { file: originalName, size: file.size }),
      newEvent('converted', null, { pages: pageCount, ms: Date.now() - startedAt }),
    ],
  };
  await store.createOffer(offer);
  res.status(201).json({ offer: publicView(offer), whatsappText: whatsappText(offer) });
});

app.get('/api/admin/offers/:id/events', requireAdmin, (req, res) => {
  const offer = store.findById(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Не найдено' });
  res.json({ events: offer.events || [], pageAcks: offer.pageAcks || {}, pageCount: offer.pageCount || null });
});

// Менеджер скопировал ссылку / открыл WhatsApp → «Отправлен клиенту».
app.post('/api/admin/offers/:id/sent', requireAdmin, async (req, res) => {
  const offer = store.findById(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Не найдено' });
  if (!(offer.events || []).some((e) => e.type === 'sent')) {
    const via = ['copy', 'whatsapp'].includes(req.body && req.body.via) ? req.body.via : 'copy';
    await store.updateOffer(offer.id, { events: withEvents(offer, newEvent('sent', null, { via })) });
  }
  res.json({ offer: publicView(store.findById(offer.id)) });
});

function sendDocFile(res, offer, name, type, disposition, asciiName, utf8Name) {
  const file = path.join(store.docDir(offer.id), name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Файл не найден' });
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', contentDisposition(disposition, asciiName, utf8Name));
  return fs.createReadStream(file).pipe(res);
}

app.get('/api/admin/offers/:id/source.docx', requireAdmin, (req, res) => {
  const offer = store.findById(req.params.id);
  if (!offer || !isDocx(offer)) return res.status(404).json({ error: 'Не найдено' });
  return sendDocFile(res, offer, 'source.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'attachment', `${offer.docNumber}.docx`, offer.source.originalName);
});

// Предпросмотр для менеджера — без записи «клиент открыл документ» в журнал.
app.get('/api/admin/offers/:id/source.pdf', requireAdmin, (req, res) => {
  const offer = store.findById(req.params.id);
  if (!offer || !isDocx(offer)) return res.status(404).json({ error: 'Не найдено' });
  return sendDocFile(res, offer, 'source.pdf', 'application/pdf', 'inline', `${offer.docNumber}.pdf`, `${offer.docTitle}.pdf`);
});

// Менеджер отмечает поступление первого транша → считается дата окончания брони.
app.post('/api/admin/offers/:id/paid', requireAdmin, async (req, res) => {
  const offer = store.findById(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Не найдено' });
  if (isDocx(offer)) return res.status(409).json({ error: 'Для загруженных документов срок брони не ведётся' });
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
  if (isDocx(offer)) {
    return `${name}здравствуйте! Это ${config.company.brand}.\n\n`
      + `Подготовили для вас документ «${offer.docTitle}» (${offer.pageCount} стр.). Пожалуйста, ознакомьтесь с ним и подпишите по ссылке — регистрироваться не нужно, подпись ставится пальцем прямо на экране:\n`
      + `${config.publicBaseUrl}/o/${offer.token}\n\n`
      + 'Ссылка персональная. После подписания вы сможете сразу скачать подписанный документ.';
  }
  return `${name}здравствуйте! Это ${config.company.brand}.\n\n`
    + `Перед бронированием места, пожалуйста, ознакомьтесь с офертой по ссылке — там подробно описано, что вы бронируете, на какой срок и на каких условиях:\n`
    + `${config.publicBaseUrl}/o/${offer.token}\n\n`
    + `Ссылка персональная. После подписания вам придёт PDF-документ — пришлите его мне сюда, и я отправлю реквизиты для оплаты брони.`;
}

// ------------------------------------------------------------- публичное API

app.get('/api/offers/:token', async (req, res) => {
  const offer = store.findByToken(req.params.token);
  if (!offer) return res.status(404).json({ error: 'Ссылка не найдена или устарела' });

  if (isDocx(offer)) return docxView(req, res, offer);

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
  const imageError = signatureImageError(s.signatureImage);
  if (imageError) errors.push(imageError);

  s.timeOnPageSec = Math.max(0, Math.min(86400, Number(body.timeOnPageSec) || 0));

  return { errors, signature: s };
}

function signatureImageError(image) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)) return 'Поставьте подпись в поле для подписи';
  if (image.length < 500) return 'Подпись слишком короткая — распишитесь ещё раз';
  if (image.length > 2_000_000) return 'Изображение подписи слишком большое';
  return null;
}

function fullNameError(name) {
  if (name.length < 5 || name.split(' ').length < 2) return 'Укажите фамилию и имя полностью';
  if (name.length > 120) return 'Слишком длинное ФИО';
  return null;
}

// ------------------------------------------------- загруженный документ: клиент

async function docxView(req, res, offer) {
  if (offer.status === 'draft') {
    const now = new Date().toISOString();
    await store.updateOffer(offer.id, {
      firstOpenedAt: offer.firstOpenedAt || now,
      events: withEvents(offer, newEvent('opened', req)),
    });
  }
  res.json({
    kind: 'docx',
    status: offer.status,
    docNumber: offer.docNumber,
    docTitle: offer.docTitle,
    pageCount: offer.pageCount,
    pageAcks: offer.pageAcks || {},
    clientHint: offer.clientHint,
    phoneHint: offer.phoneHint,
    company: config.company,
    finalAckText: FINAL_ACK_TEXT,
    sourcePdfUrl: `/o/${offer.token}/source.pdf`,
    signedAt: offer.signature ? offer.signature.signedAt : null,
    signedName: offer.signature ? offer.signature.fullName : null,
    documentHash: offer.documentHash || null,
    pdfUrl: offer.status === 'signed' ? `/o/${offer.token}/pdf` : null,
  });
}

// Общие проверки для просмотра/отметки страницы. Возвращает номер страницы или null (ответ уже отправлен).
function pageGuard(req, res, offer) {
  if (!offer || !isDocx(offer)) { res.status(404).json({ error: 'Ссылка не найдена или устарела' }); return null; }
  if (offer.status === 'signed') { res.status(409).json({ error: 'Документ уже подписан' }); return null; }
  if (offer.status === 'cancelled') { res.status(409).json({ error: 'Ссылка отменена. Обратитесь к менеджеру.' }); return null; }
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > offer.pageCount) { res.status(400).json({ error: 'Нет такой страницы' }); return null; }
  if (!rateLimit(`page:${clientIp(req)}`, 600, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Слишком много запросов. Попробуйте через несколько минут.' });
    return null;
  }
  return n;
}

app.post('/api/offers/:token/pages/:n/view', async (req, res) => {
  const offer = store.findByToken(req.params.token);
  const n = pageGuard(req, res, offer);
  if (n === null) return undefined;
  if (n > ackedCount(offer) + 1) {
    return res.status(409).json({ error: 'Сначала подтвердите предыдущие страницы', nextPage: ackedCount(offer) + 1 });
  }
  const key = String(n);
  if (!offer.pageViews || !offer.pageViews[key]) {
    const at = new Date().toISOString();
    await store.updateOffer(offer.id, {
      pageViews: { ...(offer.pageViews || {}), [key]: at },
      events: withEvents(offer, newEvent('page_viewed', req, { page: n })),
    });
  }
  return res.json({ ok: true });
});

app.post('/api/offers/:token/pages/:n/ack', async (req, res) => {
  const offer = store.findByToken(req.params.token);
  const n = pageGuard(req, res, offer);
  if (n === null) return undefined;
  const key = String(n);
  const acked = ackedCount(offer);
  if (offer.pageAcks && offer.pageAcks[key]) return res.json({ pageAcks: offer.pageAcks, acked });
  if (n !== acked + 1) {
    return res.status(409).json({ error: 'Страницы подтверждаются строго по порядку', nextPage: acked + 1 });
  }
  const viewedAt = offer.pageViews && offer.pageViews[key];
  if (!viewedAt || Date.now() - new Date(viewedAt).getTime() < MIN_PAGE_VIEW_MS) {
    return res.status(409).json({ error: 'Сначала просмотрите страницу' });
  }
  const pageAcks = { ...(offer.pageAcks || {}), [key]: new Date().toISOString() };
  await store.updateOffer(offer.id, {
    pageAcks,
    events: withEvents(offer, newEvent('page_acked', req, { page: n })),
  });
  return res.json({ pageAcks, acked: acked + 1 });
});

app.get('/o/:token/source.pdf', (req, res) => {
  const offer = store.findByToken(req.params.token);
  if (!offer || !isDocx(offer) || offer.status === 'cancelled') return res.status(404).send('Документ не найден');
  return sendDocFile(res, offer, 'source.pdf', 'application/pdf', 'inline', `${offer.docNumber}.pdf`, `${offer.docTitle}.pdf`);
});

// Время из браузера (когда ввёл ФИО, расписался) берём, только если оно между последней отметкой
// страницы и подписанием по часам сервера — иначе порядок событий в протоколе мог бы нарушиться.
function clientTime(value, notBefore, now) {
  const t = new Date(value);
  if (!value || Number.isNaN(t.getTime())) return null;
  if (t.getTime() > now.getTime()) return null;
  if (notBefore && t.getTime() < new Date(notBefore).getTime()) return null;
  return t.toISOString();
}

async function signedDocxPdf(offer) {
  const protocol = await renderDocxProtocol(offer);
  const source = await fsp.readFile(path.join(store.docDir(offer.id), 'source.pdf'));
  return buildSignedPdf(source, protocol, offer);
}

async function signDocx(req, res, offer) {
  const body = req.body || {};
  const errors = [];

  for (let n = 1; n <= offer.pageCount; n += 1) {
    if (!offer.pageAcks || !offer.pageAcks[String(n)]) {
      errors.push(`Подтвердите ознакомление со страницей ${n}`);
      break;
    }
  }

  const fullName = (body.fullName || '').toString().trim().replace(/\s+/g, ' ');
  const nameError = fullNameError(fullName);
  if (nameError) errors.push(nameError);

  const phone = (body.phone || '').toString().trim();
  if (phone && !/^\+?[\d\s()-]{9,20}$/.test(phone)) errors.push('Проверьте номер телефона');

  const signatureImage = (body.signatureImage || '').toString();
  const imageError = signatureImageError(signatureImage);
  if (imageError) errors.push(imageError);

  if (body.finalAck !== true) errors.push('Подтвердите согласие с условиями документа');

  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const now = new Date();
  const signedAt = now.toISOString();
  const lastPageAckAt = Object.values(offer.pageAcks).sort().pop();
  const signature = {
    signingId: crypto.randomUUID(),
    fullName,
    phone: phone || null,
    signatureImage,
    pageAcks: { ...offer.pageAcks },
    finalAckText: FINAL_ACK_TEXT,
    finalAckAt: clientTime(body.finalAckAt, lastPageAckAt, now) || signedAt,
    signedAt,
    ip: clientIp(req),
    userAgent: (req.get('user-agent') || '').slice(0, 250),
  };

  const documentHash = sha256(JSON.stringify({
    docNumber: offer.docNumber,
    documentId: offer.id,
    sourceHash: offer.source.sourceHash,
    pdfHash: offer.source.pdfHash,
    pageCount: offer.pageCount,
    pageAcks: signature.pageAcks,
    signer: { fullName: signature.fullName, phone: signature.phone },
    signatureImageHash: sha256(signatureImage),
    finalAckAt: signature.finalAckAt,
    signedAt,
    signingId: signature.signingId,
  }));

  const nameAt = clientTime(body.nameEnteredAt, lastPageAckAt, now);
  const drawnAt = clientTime(body.signatureDrawnAt, lastPageAckAt, now);
  const events = [
    { ...newEvent('name_entered', req, { name: fullName }), ...(nameAt ? { at: nameAt } : {}) },
    { ...newEvent('signature_drawn', req), ...(drawnAt ? { at: drawnAt } : {}) },
    newEvent('signed', req, { signingId: signature.signingId }),
  ];

  const patched = await store.updateOffer(offer.id, {
    status: 'signed',
    signature,
    documentHash,
    events: withEvents(offer, ...events),
  });

  try {
    await fsp.writeFile(store.pdfPath(patched), await signedDocxPdf(patched));
  } catch (err) {
    console.error('[pdf] не удалось собрать подписанный документ:', err);
    return res.status(500).json({ error: 'Подпись сохранена, но PDF не сформировался. Свяжитесь с менеджером.' });
  }

  return res.json({ ok: true, docNumber: patched.docNumber, signedAt, documentHash, pdfUrl: `/o/${offer.token}/pdf` });
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

  if (isDocx(offer)) return signDocx(req, res, offer);

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
    const pdf = isDocx(offer)
      ? await signedDocxPdf(offer)
      : await renderProtocol(offer, buildOffer(offer.params, config.company));
    await fsp.writeFile(file, pdf);
  }
  // ?inline=1 — открыть в браузере вместо скачивания (удобно менеджеру для быстрого просмотра).
  const disposition = req.query.inline ? 'inline' : 'attachment';
  const [ascii, utf8] = isDocx(offer)
    ? [`Document_${offer.docNumber}_signed.pdf`, `${offer.docTitle.replace(/[\\/:*?"<>|]+/g, ' ').trim()} — подписан ${offer.docNumber}.pdf`]
    : [`Oferta_bronirovanie_${offer.docNumber}.pdf`, `Оферта_бронирование_${offer.docNumber}.pdf`];
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition(disposition, ascii, utf8));
  fs.createReadStream(file).pipe(res);
});

// Проверка живости для хостинга (Railway healthcheck).
app.get('/healthz', (req, res) => {
  res.json({ ok: true, offerVersion: OFFER_VERSION, offers: store.listOffers().length });
});

// ----------------------------------------------------------------- страницы

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// pdf.js для постраничного просмотра документа — из node_modules, без CDN.
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const vendorStatic = (dir) => express.static(path.join(pdfjsRoot, dir), { maxAge: '7d', immutable: true });
app.use('/vendor/pdfjs/build', vendorStatic('legacy/build'));
app.use('/vendor/pdfjs/standard_fonts', vendorStatic('standard_fonts'));
app.use('/vendor/pdfjs/cmaps', vendorStatic('cmaps'));

app.get('/o/:token', (req, res) => {
  const offer = store.findByToken(req.params.token);
  const page = offer && isDocx(offer) ? 'offer-doc.html' : 'offer.html';
  res.sendFile(path.join(__dirname, 'public', page));
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
