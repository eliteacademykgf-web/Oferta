'use strict';

/**
 * Файловое хранилище (JSON). Специально изолировано за узким интерфейсом,
 * чтобы при подключении к серверу заменить его на Postgres/SQLite,
 * не трогая остальной код: достаточно реализовать те же методы.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');

const dbFile = path.join(config.dataDir, 'offers.json');
const pdfDir = path.join(config.dataDir, 'pdf');
const docsDir = path.join(config.dataDir, 'docs');

fs.mkdirSync(pdfDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });

let cache = null;
let writeChain = Promise.resolve();

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  } catch {
    cache = { offers: [] };
  }
  return cache;
}

function persist() {
  // Последовательная запись: никаких гонок между параллельными запросами.
  writeChain = writeChain.then(async () => {
    const tmp = `${dbFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fsp.rename(tmp, dbFile);
  });
  return writeChain;
}

async function createOffer(offer) {
  load().offers.push(offer);
  await persist();
  return offer;
}

function listOffers() {
  return load().offers.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function findByToken(token) {
  if (!token) return null;
  return load().offers.find((o) => o.token === token) || null;
}

function findById(id) {
  if (!id) return null;
  return load().offers.find((o) => o.id === id) || null;
}

async function updateOffer(id, patch) {
  const offer = findById(id);
  if (!offer) return null;
  Object.assign(offer, patch);
  await persist();
  return offer;
}

function pdfPath(offer) {
  return path.join(pdfDir, `${offer.docNumber.replace(/[^\w-]/g, '_')}.pdf`);
}

// Исходный .docx и его PDF-версия для просмотра. id — UUID, поэтому путь безопасен.
function docDir(id) {
  return path.join(docsDir, id);
}

module.exports = { createOffer, listOffers, findByToken, findById, updateOffer, pdfPath, pdfDir, docDir };
