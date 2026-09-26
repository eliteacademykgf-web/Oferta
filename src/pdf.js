'use strict';

/**
 * Генерация PDF «Протокол акцепта оферты».
 * Шрифт DejaVu Sans — полная поддержка кириллицы, лежит в assets/fonts.
 */

const path = require('path');
const PDFDocument = require('pdfkit');
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

/**
 * @param {object} offer — запись из хранилища (со signature)
 * @param {object} document — результат buildOffer()
 * @returns {Promise<Buffer>}
 */
function renderProtocol(offer, document) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: {
      Title: `Протокол акцепта оферты ${offer.docNumber}`,
      Author: config.company.legalName,
      Subject: 'Акцепт публичной оферты о бронировании',
    } });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('reg', FONT);
    doc.registerFont('bold', FONT_BOLD);
    doc.font('reg').fillColor(TEXT);

    const M = doc.page.margins.left;
    const W = doc.page.width - M * 2;
    const sig = offer.signature;

    // ---------- helpers ----------
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

    const kv = (rows) => {
      const labelW = 165;
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

    // ---------- шапка ----------
    doc.rect(0, 0, doc.page.width, 96).fill(NAVY_DEEP);
    doc.rect(0, 92, doc.page.width, 4).fill(BLUE);
    doc.font('bold').fontSize(15).fillColor('#FFFFFF').text(config.company.brand.toUpperCase(), M, 26, { width: W });
    doc.font('reg').fontSize(8.5).fillColor('#B8D8EC')
      .text(`${config.company.legalName} · ИНН ${config.company.inn} · ${config.company.phone}`, M, 48, { width: W });
    doc.font('bold').fontSize(10).fillColor('#FFFFFF')
      .text('ПРОТОКОЛ АКЦЕПТА ПУБЛИЧНОЙ ОФЕРТЫ', M, 66, { width: W });
    doc.y = 120;
    doc.fillColor(TEXT);

    // ---------- реквизиты протокола ----------
    kv([
      ['Номер протокола', offer.docNumber],
      ['Дата и время акцепта', `${fmtDateTime(sig.signedAt)} (${config.timezone})`],
      ['Редакция оферты', `${document.version} от ${document.versionDate}`],
      ['Статус', 'Оферта принята Клиентом в электронной форме'],
    ]);

    // ---------- клиент ----------
    h1('1. Клиент');
    kv([
      ['ФИО', sig.fullName],
      ['Дата рождения', sig.birthDate ? fmtDate(sig.birthDate) : '—'],
      ['Документ (паспорт/ID)', sig.docNumber || '—'],
      ['Телефон (WhatsApp)', sig.phone],
      ['E-mail', sig.email || '—'],
    ]);

    // ---------- условия ----------
    h1('2. Существенные условия бронирования');
    kv(document.summary.map((s) => [s.label, s.value]));
    para(
      `Дата окончания срока брони определяется как ${offer.params.bookingDays} календарных дней с даты фактического поступления бронирующего платежа и подтверждается менеджером Компании письменно.`,
      { color: GRAY, size: 8.5 },
    );

    // ---------- отметки ----------
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

    // ---------- подпись ----------
    doc.y += 6;
    h1('4. Подпись Клиента');
    need(150);
    const sigTop = doc.y;
    const boxW = W * 0.52;
    doc.rect(M, sigTop, boxW, 110).fill('#FFFFFF').strokeColor(LINE).lineWidth(0.7).stroke();
    if (sig.signatureImage) {
      try {
        const base64 = sig.signatureImage.split(',')[1];
        doc.image(Buffer.from(base64, 'base64'), M + 10, sigTop + 8, { fit: [boxW - 20, 70], align: 'center', valign: 'center' });
      } catch { /* повреждённое изображение не должно ломать протокол */ }
    }
    doc.moveTo(M + 14, sigTop + 84).lineTo(M + boxW - 14, sigTop + 84).strokeColor(LINE).stroke();
    doc.font('reg').fontSize(8).fillColor(GRAY)
      .text('Графическая подпись Клиента', M + 14, sigTop + 88, { width: boxW - 28, align: 'center' });

    doc.font('reg').fontSize(9).fillColor(GRAY).text('Подписано собственноручным вводом:', M + boxW + 16, sigTop + 6, { width: W - boxW - 16 });
    doc.font('bold').fontSize(11).fillColor(TEXT).text(sig.typedName, M + boxW + 16, doc.y + 2, { width: W - boxW - 16 });
    doc.font('reg').fontSize(9).fillColor(GRAY).text(`Дата: ${fmtDateTime(sig.signedAt)}`, M + boxW + 16, doc.y + 6, { width: W - boxW - 16 });
    doc.font('reg').fontSize(8).fillColor(GRAY).text(
      'Стороны признают простую электронную подпись равнозначной собственноручной (п. 11.2 оферты).',
      M + boxW + 16, doc.y + 6, { width: W - boxW - 16, lineGap: 1 },
    );
    doc.y = sigTop + 122;

    // ---------- технические данные ----------
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

    // ---------- полный текст оферты ----------
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

    // ---------- колонтитулы ----------
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      // Колонтитул печатается ниже нижнего поля — без этого pdfkit считает его
      // переполнением и добавляет пустую страницу на каждый колонтитул.
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - 34;
      doc.moveTo(M, y - 6).lineTo(M + W, y - 6).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('reg').fontSize(7).fillColor(GRAY)
        .text(`${offer.docNumber} · ${config.company.brand} · SHA-256 ${offer.documentHash.slice(0, 16)}…`, M, y, { width: W * 0.75, lineBreak: false });
      doc.font('reg').fontSize(7).fillColor(GRAY)
        .text(`стр. ${i + 1} из ${range.count}`, M + W * 0.75, y, { width: W * 0.25, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}

module.exports = { renderProtocol, fmtDateTime, fmtDate };
