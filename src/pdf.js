'use strict';

/**
 * Генерация PDF:
 *  - renderProtocol      — протокол акцепта встроенной оферты (старый режим);
 *  - renderDocxProtocol  — лист подписания загруженного Word-документа;
 *  - buildSignedPdf      — итоговый документ: страницы исходника без изменений + лист подписания.
 * Шрифт DejaVu Sans — полная поддержка кириллицы, лежит в assets/fonts.
 */

const path = require('path');
const PDFDocument = require('pdfkit');
const { PDFDocument: PdfLibDocument, StandardFonts, rgb } = require('pdf-lib');
const config = require('./config');

const NAVY = '#064066';
const NAVY_DEEP = '#01182d';
const BLUE = '#1A5E90';
const GRAY = '#64748B';
const LINE = '#CBD5E1';
const TEXT = '#1E293B';
const SOFT = '#F1F5F9';

const FONT = path.join(config.fontsDir, 'DejaVuSans.ttf');
const FONT_BOLD = path.join(config.fontsDir, 'DejaVuSans-Bold.ttf');

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: config.timezone,
  }).format(new Date(iso)).replace(',', '');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: config.timezone,
  }).format(new Date(iso));
}

// ------------------------------------------------------------------ общая вёрстка

function newDocument(info) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('reg', FONT);
  doc.registerFont('bold', FONT_BOLD);
  doc.font('reg').fillColor(TEXT);
  return { doc, done };
}

function createLayout(doc) {
  const M = doc.page.margins.left;
  const W = doc.page.width - M * 2;

  const need = (h) => {
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 24) doc.addPage();
  };

  const h1 = (text) => {
    need(40);
    doc.font('bold').fontSize(13).fillColor(NAVY).text(text.toUpperCase(), M, doc.y, { width: W });
    doc.moveTo(M, doc.y + 4).lineTo(M + W, doc.y + 4).lineWidth(1).strokeColor(NAVY).stroke();
    doc.y += 12;
    doc.font('reg').fontSize(9.5).fillColor(TEXT);
  };

  const h2 = (text) => {
    need(32);
    doc.font('bold').fontSize(10.5).fillColor(NAVY).text(text, M, doc.y, { width: W });
    doc.y += 4;
    doc.font('reg').fontSize(9.5).fillColor(TEXT);
  };

  const para = (text, opts = {}) => {
    const size = opts.size || 9.5;
    doc.font(opts.bold ? 'bold' : 'reg').fontSize(size).fillColor(opts.color || TEXT);
    const h = doc.heightOfString(text, { width: W, align: opts.align || 'justify', lineGap: 1.5 });
    need(Math.min(h, 120));
    doc.text(text, M, doc.y, { width: W, align: opts.align || 'justify', lineGap: 1.5 });
    doc.y += opts.gap === undefined ? 5 : opts.gap;
  };

  const kv = (rows, labelW = 165) => {
    rows.forEach(([label, value], i) => {
      // Мерить нужно тем же начертанием, которым потом рисуем, иначе строка «выползет» из полосы.
      doc.font('bold').fontSize(9.5);
      const vh = doc.heightOfString(String(value), { width: W - labelW - 10, lineGap: 1 });
      const rowH = Math.max(vh, 12) + 8;
      need(rowH + 4);
      const y = doc.y;
      if (i % 2 === 0) doc.rect(M, y - 3, W, rowH).fill(SOFT);
      doc.fillColor(GRAY).font('reg').fontSize(9).text(label, M + 6, y, { width: labelW - 12 });
      doc.fillColor(TEXT).font('bold').fontSize(9.5).text(String(value), M + labelW, y, { width: W - labelW - 10, lineGap: 1 });
      doc.y = y + rowH;
    });
    doc.y += 6;
    doc.font('reg').fontSize(9.5).fillColor(TEXT);
  };

  const header = (title) => {
    doc.rect(0, 0, doc.page.width, 96).fill(NAVY_DEEP);
    doc.rect(0, 92, doc.page.width, 4).fill(BLUE);
    doc.font('bold').fontSize(15).fillColor('#FFFFFF').text(config.company.brand.toUpperCase(), M, 26, { width: W });
    doc.font('reg').fontSize(8.5).fillColor('#B8D8EC')
      .text(`${config.company.legalName} · ИНН ${config.company.inn} · ${config.company.phone}`, M, 48, { width: W });
    doc.font('bold').fontSize(10).fillColor('#FFFFFF').text(title, M, 66, { width: W });
    doc.y = 120;
    doc.fillColor(TEXT);
  };

  // Рамка с графической подписью слева, текстовые реквизиты подписи справа.
  const signatureBlock = (signatureImage, side) => {
    need(150);
    const sigTop = doc.y;
    const boxW = W * 0.52;
    doc.rect(M, sigTop, boxW, 110).fill('#FFFFFF').strokeColor(LINE).lineWidth(0.7).stroke();
    if (signatureImage) {
      try {
        const base64 = signatureImage.split(',')[1];
        doc.image(Buffer.from(base64, 'base64'), M + 10, sigTop + 8, { fit: [boxW - 20, 70], align: 'center', valign: 'center' });
      } catch { /* повреждённое изображение не должно ломать протокол */ }
    }
    doc.moveTo(M + 14, sigTop + 84).lineTo(M + boxW - 14, sigTop + 84).strokeColor(LINE).stroke();
    doc.font('reg').fontSize(8).fillColor(GRAY)
      .text(side.caption, M + 14, sigTop + 88, { width: boxW - 28, align: 'center' });

    const x = M + boxW + 16;
    const w = W - boxW - 16;
    doc.font('reg').fontSize(9).fillColor(GRAY).text(side.label, x, sigTop + 6, { width: w });
    doc.font('bold').fontSize(11).fillColor(TEXT).text(side.name, x, doc.y + 2, { width: w });
    doc.font('reg').fontSize(9).fillColor(GRAY).text(`Дата: ${fmtDateTime(side.signedAt)}`, x, doc.y + 6, { width: w });
    doc.font('reg').fontSize(8).fillColor(GRAY).text(side.note, x, doc.y + 6, { width: w, lineGap: 1 });
    doc.y = sigTop + 122;
  };

  return { M, W, need, h1, h2, para, kv, header, signatureBlock };
}

function stampFooters(doc, M, W, leftText) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    // Колонтитул печатается ниже нижнего поля — без этого pdfkit считает его
    // переполнением и добавляет пустую страницу на каждый колонтитул.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 34;
    doc.moveTo(M, y - 6).lineTo(M + W, y - 6).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('reg').fontSize(7).fillColor(GRAY).text(leftText, M, y, { width: W * 0.75, lineBreak: false });
    doc.font('reg').fontSize(7).fillColor(GRAY)
      .text(`стр. ${i + 1} из ${range.count}`, M + W * 0.75, y, { width: W * 0.25, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
}

// ------------------------------------------------- старый режим: встроенная оферта

/**
 * @param {object} offer — запись из хранилища (со signature)
 * @param {object} document — результат buildOffer()
 * @returns {Promise<Buffer>}
 */
function renderProtocol(offer, document) {
  const { doc, done } = newDocument({
    Title: `Протокол акцепта оферты ${offer.docNumber}`,
    Author: config.company.legalName,
    Subject: 'Акцепт публичной оферты о бронировании',
  });
  const { M, W, need, h1, h2, para, kv, header, signatureBlock } = createLayout(doc);
  const sig = offer.signature;

  header('ПРОТОКОЛ АКЦЕПТА ПУБЛИЧНОЙ ОФЕРТЫ');

  kv([
    ['Номер протокола', offer.docNumber],
    ['Дата и время акцепта', `${fmtDateTime(sig.signedAt)} (${config.timezone})`],
    ['Редакция оферты', `${document.version} от ${document.versionDate}`],
    ['Статус', 'Оферта принята Клиентом в электронной форме'],
  ]);

  h1('1. Клиент');
  kv([
    ['ФИО', sig.fullName],
    ['Дата рождения', sig.birthDate ? fmtDate(sig.birthDate) : '—'],
    ['Документ (паспорт/ID)', sig.docNumber || '—'],
    ['Телефон (WhatsApp)', sig.phone],
    ['E-mail', sig.email || '—'],
  ]);

  h1('2. Существенные условия бронирования');
  kv(document.summary.map((s) => [s.label, s.value]));
  para(
    `Дата окончания срока брони определяется как ${offer.params.bookingDays} календарных дней с даты фактического поступления бронирующего платежа и подтверждается менеджером Компании письменно.`,
    { color: GRAY, size: 8.5 },
  );

  h1('3. Отметки Клиента об ознакомлении');
  para('Каждая отметка проставлена Клиентом отдельно; зафиксированы дата и время каждой отметки.', { color: GRAY, size: 8.5, gap: 8 });

  document.acks.forEach((ack, idx) => {
    const t = sig.acks[ack.id];
    const text = `${idx + 1}. ${ack.text}`;
    doc.font('reg').fontSize(9);
    const th = doc.heightOfString(text, { width: W - 40, lineGap: 1 });
    need(th + 24);
    const y = doc.y;
    doc.rect(M, y - 2, W, th + 20).fill('#FFFFFF').strokeColor(LINE).lineWidth(0.7).stroke();
    doc.font('bold').fontSize(11).fillColor('#15803D').text('✓', M + 8, y + 3, { width: 16 });
    doc.font('reg').fontSize(9).fillColor(TEXT).text(text, M + 28, y + 4, { width: W - 40, lineGap: 1 });
    doc.font('reg').fontSize(7.5).fillColor(GRAY)
      .text(`Отмечено: ${fmtDateTime(t)} · раздел: ${ack.sectionTitle}`, M + 28, y + th + 6, { width: W - 40 });
    doc.y = y + th + 24;
  });

  doc.y += 6;
  h1('4. Подпись Клиента');
  signatureBlock(sig.signatureImage, {
    caption: 'Графическая подпись Клиента',
    label: 'Подписано собственноручным вводом:',
    name: sig.typedName,
    signedAt: sig.signedAt,
    note: 'Стороны признают простую электронную подпись равнозначной собственноручной (п. 11.2 оферты).',
  });

  h1('5. Технические данные акцепта');
  kv([
    ['Идентификатор сессии', offer.token],
    ['IP-адрес Клиента', sig.ip || '—'],
    ['Устройство / браузер', sig.userAgent || '—'],
    ['Ссылка открыта', fmtDateTime(offer.firstOpenedAt)],
    ['Время на странице', sig.timeOnPageSec ? `${Math.floor(sig.timeOnPageSec / 60)} мин ${sig.timeOnPageSec % 60} сек` : '—'],
    ['Ссылку выдал', offer.createdBy || '—'],
    ['Хеш документа (SHA-256)', offer.documentHash],
  ]);
  para(
    'Хеш-сумма рассчитана от полного текста оферты в редакции на дату акцепта и данных настоящего протокола. Любое изменение текста после подписания приведёт к несовпадению хеш-суммы.',
    { color: GRAY, size: 8.5 },
  );

  doc.addPage();
  doc.font('bold').fontSize(13).fillColor(NAVY).text(document.title, M, doc.y, { width: W, align: 'center' });
  doc.font('reg').fontSize(8.5).fillColor(GRAY).text(document.subtitle, M, doc.y + 6, { width: W, align: 'center' });
  doc.y += 18;

  document.sections.forEach((s) => {
    h2(s.no ? `${s.no}. ${s.title}` : s.title);
    s.blocks.forEach((b) => para(b, { gap: 4 }));
    if (s.ack) {
      const t = `Отметка Клиента: ${s.ack.text}`;
      doc.font('reg').fontSize(8.5);
      const th = doc.heightOfString(t, { width: W - 20, lineGap: 1 });
      need(th + 18);
      const y = doc.y;
      doc.rect(M, y, W, th + 12).fill('#E1EEF7');
      doc.fillColor(NAVY).font('reg').fontSize(8.5).text(t, M + 10, y + 6, { width: W - 20, lineGap: 1 });
      doc.y = y + th + 16;
    }
    doc.y += 4;
  });

  h2('Финальная отметка');
  para(document.finalAck.text, { gap: 4 });

  doc.y += 10;
  para(
    `Оферта принята Клиентом ${fmtDateTime(sig.signedAt)}. Протокол сформирован автоматически и не требует печати и подписи Компании.`,
    { color: GRAY, size: 8.5, align: 'left' },
  );

  stampFooters(doc, M, W, `${offer.docNumber} · ${config.company.brand} · SHA-256 ${offer.documentHash.slice(0, 16)}…`);
  doc.end();
  return done;
}

// ------------------------------------------------- загруженный документ (Word или PDF)

/**
 * Лист подписания загруженного документа (одна-две страницы, добавляются в конец исходника).
 * @param {object} offer — запись kind:'docx' со signature и documentHash
 * @returns {Promise<Buffer>}
 */
function renderDocxProtocol(offer) {
  const { doc, done } = newDocument({
    Title: `Лист подписания ${offer.docNumber}`,
    Author: config.company.legalName,
    Subject: `Электронное подписание: ${offer.docTitle}`,
  });
  const { M, W, need, h1, para, kv, header, signatureBlock } = createLayout(doc);
  const sig = offer.signature;

  header('ЛИСТ ЭЛЕКТРОННОГО ПОДПИСАНИЯ ДОКУМЕНТА');

  kv([
    ['Документ', `${offer.docTitle} (${offer.pageCount} стр.)`],
    ['Номер', offer.docNumber],
    ['Исходный файл', offer.source.originalName],
    ['Подписант', sig.phone ? `${sig.fullName}, тел. ${sig.phone}` : sig.fullName],
    ['Дата и время подписания', `${fmtDateTime(sig.signedAt)} (${config.timezone})`],
  ]);

  h1('1. Подтверждение ознакомления со страницами');
  para('Страницы открывались строго по порядку; каждая подтверждена подписантом отдельной отметкой «Я ознакомился(ась) с содержанием данной страницы». Зафиксированы дата и время каждой отметки.', { color: GRAY, size: 8.5, gap: 8 });

  // Две колонки, чтобы документ на 20+ страниц не растягивал лист подписания.
  const colW = (W - 12) / 2;
  const pages = Array.from({ length: offer.pageCount }, (_, i) => i + 1);
  for (let i = 0; i < pages.length; i += 2) {
    need(20);
    const y = doc.y;
    [pages[i], pages[i + 1]].forEach((n, col) => {
      if (!n) return;
      const x = M + col * (colW + 12);
      doc.rect(x, y - 2, colW, 16).fill(i % 4 === 0 ? SOFT : '#FFFFFF');
      doc.font('bold').fontSize(9).fillColor('#15803D').text('✓', x + 6, y + 1, { width: 12, lineBreak: false });
      doc.font('reg').fontSize(8.5).fillColor(TEXT)
        .text(`Страница ${n} — ${fmtDateTime(sig.pageAcks[String(n)])}`, x + 20, y + 1.5, { width: colW - 24, lineBreak: false });
    });
    doc.y = y + 18;
  }
  doc.y += 4;
  para(`Итоговое подтверждение: «${sig.finalAckText}» — ${fmtDateTime(sig.finalAckAt)}.`, { size: 8.5, gap: 8 });

  h1('2. Электронная подпись');
  signatureBlock(sig.signatureImage, {
    caption: 'Подпись, нарисованная подписантом',
    label: 'Подписант:',
    name: sig.fullName,
    signedAt: sig.signedAt,
    note: 'Простая электронная подпись: подписант нарисовал подпись на экране своего устройства и подтвердил подписание.',
  });

  h1('3. Электронный след подписания');
  kv([
    ['ID подписания', sig.signingId],
    ['ID документа', offer.id],
    ['Ссылка впервые открыта', fmtDateTime(offer.firstOpenedAt)],
    ['IP-адрес', sig.ip || '—'],
    ['Устройство / браузер', sig.userAgent || '—'],
  ]);
  // Хеши — мелким шрифтом в одну строку каждый, иначе они переносятся и выталкивают лист на вторую страницу.
  const isPdfSource = offer.source.format === 'pdf';
  [
    [`SHA-256 исходного .${isPdfSource ? 'pdf' : 'docx'}`, offer.source.sourceHash],
    isPdfSource ? null : ['SHA-256 PDF для просмотра', offer.source.pdfHash],
    ['SHA-256 подписания', offer.documentHash],
  ].filter(Boolean).forEach(([label, hash]) => {
    need(14);
    const y = doc.y;
    doc.font('reg').fontSize(8).fillColor(GRAY).text(label, M + 6, y, { width: 150, lineBreak: false });
    doc.font('bold').fontSize(7.6).fillColor(TEXT).text(hash, M + 150, y + 0.5, { width: W - 150, lineBreak: false });
    doc.y = y + 13;
  });
  doc.y += 6;
  para(
    'Хеш подписания рассчитан от хешей исходного документа, номеров и времени подтверждения каждой страницы, данных подписанта и времени подписания. Любое изменение документа или этих данных после подписания приведёт к несовпадению хеш-суммы. Номер документа и хеш подписания проставлены внизу каждой страницы.',
    { color: GRAY, size: 8.5 },
  );

  doc.end();
  return done;
}

/**
 * Итоговый PDF: все страницы исходника без изменений содержимого + лист подписания,
 * внизу каждой страницы — номер документа, хеш подписания и нумерация.
 * Колонтитул латиницей: стандартный шрифт pdf-lib не содержит кириллицы.
 */
async function buildSignedPdf(sourcePdf, protocolPdf, offer) {
  const out = await PdfLibDocument.create();
  const src = await PdfLibDocument.load(sourcePdf, { ignoreEncryption: true });
  const proto = await PdfLibDocument.load(protocolPdf);

  (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
  (await out.copyPages(proto, proto.getPageIndices())).forEach((p) => out.addPage(p));

  const font = await out.embedFont(StandardFonts.Helvetica);
  const pages = out.getPages();
  const label = `${offer.docNumber} | signed ${new Date(offer.signature.signedAt).toISOString().slice(0, 19).replace('T', ' ')} UTC | SHA-256 ${offer.documentHash.slice(0, 24)}...`;
  pages.forEach((page, i) => {
    const { width } = page.getSize();
    const text = `${label} | ${i + 1}/${pages.length}`;
    const size = 6.5;
    const tw = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: Math.max(8, (width - tw) / 2), y: 8, size, font, color: rgb(0.45, 0.5, 0.58) });
  });

  out.setTitle(`${offer.docTitle} — ${offer.docNumber}`);
  out.setAuthor(config.company.legalName);
  out.setSubject('Документ, подписанный простой электронной подписью');
  return Buffer.from(await out.save());
}

module.exports = { renderProtocol, renderDocxProtocol, buildSignedPdf, fmtDateTime, fmtDate };
