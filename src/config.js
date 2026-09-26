'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Локально настройки берутся из .env, на хостинге (Railway и т.п.) — из переменных окружения.
// Читаем файл сами, а не флагом node --env-file: он есть не во всех версиях Node.
(function loadEnvFile() {
  const file = process.env.ENV_FILE || path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) return;
    const key = m[1];
    if (process.env[key] !== undefined) return;          // переменные окружения важнее файла
    process.env[key] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}());

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Адрес, из которого собираются ссылки для клиентов. На Railway домен подставляется сам.
const baseUrl = process.env.PUBLIC_BASE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
  || `http://localhost:${num(process.env.PORT, 4010)}`;

const config = {
  port: num(process.env.PORT, 4010),
  publicBaseUrl: baseUrl.replace(/\/+$/, ''),
  adminToken: process.env.ADMIN_TOKEN || 'change-me-please',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  fontsDir: path.join(root, 'assets', 'fonts'),
  timezone: process.env.TIMEZONE || 'Asia/Bishkek',

  // Реквизиты компании — ЗАПОЛНИТЬ реальными данными перед запуском.
  company: {
    brand: process.env.COMPANY_BRAND || 'Elite Academy KG',
    legalName: process.env.COMPANY_LEGAL_NAME || 'ОсОО «Elite Academy»',
    inn: process.env.COMPANY_INN || '__ИНН__',
    address: process.env.COMPANY_ADDRESS || 'г. Бишкек, __адрес__',
    phone: process.env.COMPANY_PHONE || '+996 __ __ __ __',
    email: process.env.COMPANY_EMAIL || 'info@eliteacademy.kg',
    site: process.env.COMPANY_SITE || 'eliteacademy.kg',
    director: process.env.COMPANY_DIRECTOR || '__ФИО директора__',
    bank: process.env.COMPANY_BANK || '__банк, р/с__',
  },

  // Условия по умолчанию (менеджер может переопределить при создании ссылки).
  defaults: {
    packageName: process.env.DEFAULT_PACKAGE || 'Сопровождение поступления в зарубежный вуз',
    bookingFee: num(process.env.DEFAULT_BOOKING_FEE, 10000),      // сом
    currency: process.env.DEFAULT_CURRENCY || 'сом',
    discountUsd: num(process.env.DEFAULT_DISCOUNT_USD, 200),      // $
    secondTrancheMin: num(process.env.DEFAULT_T2_MIN, 50000),     // сом
    secondTrancheMax: num(process.env.DEFAULT_T2_MAX, 100000),    // сом
    bookingDays: num(process.env.DEFAULT_BOOKING_DAYS, 14),       // календарных дней
    payWindowHours: num(process.env.DEFAULT_PAY_HOURS, 24),
    extensionDays: num(process.env.DEFAULT_EXTENSION_DAYS, 7),
    refundWorkDays: num(process.env.DEFAULT_REFUND_WORKDAYS, 10),
    claimDays: num(process.env.DEFAULT_CLAIM_DAYS, 10),
    dataRetentionYears: num(process.env.DEFAULT_RETENTION_YEARS, 5),
  },
};

module.exports = config;
