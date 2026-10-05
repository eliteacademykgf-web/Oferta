'use strict';

/**
 * DOCX → PDF через LibreOffice (soffice --headless). Конвертации выполняются строго по одной:
 * на сервере 1 ГБ памяти, а параллельные запуски soffice с одним профилем ещё и мешают друг другу.
 *
 * Для локальной разработки без LibreOffice: SOFFICE_DOCKER_IMAGE=<образ с soffice> —
 * конвертация пойдёт через `docker run`.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { PDFDocument } = require('pdf-lib');

const SOFFICE = process.env.SOFFICE_BIN || 'soffice';
const DOCKER_IMAGE = process.env.SOFFICE_DOCKER_IMAGE || '';
const TIMEOUT_MS = 120_000;
const PROFILE_DIR = path.join(os.tmpdir(), 'elite-offer-lo-profile');

let queue = Promise.resolve();

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const reason = err.code === 'ENOENT'
          ? `не найден ${cmd} — установите LibreOffice (см. README)`
          : (err.killed ? 'превышено время конвертации' : (stderr || err.message).toString().trim());
        return reject(new Error(`Не удалось конвертировать документ: ${reason}`));
      }
      return resolve(stdout);
    });
  });
}

function runConversion(inPath, outDir) {
  if (DOCKER_IMAGE) {
    return exec('docker', [
      'run', '--rm', '-v', `${path.resolve(outDir)}:/work`, DOCKER_IMAGE,
      'soffice', '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', '/work', `/work/${path.basename(inPath)}`,
    ]);
  }
  return exec(SOFFICE, [
    `-env:UserInstallation=${pathToFileURL(PROFILE_DIR).href}`,
    '--headless', '--norestore', '--nologo', '--nodefault',
    '--convert-to', 'pdf', '--outdir', outDir, inPath,
  ]);
}

/**
 * @param {string} inPath — путь к .docx (должен лежать внутри outDir)
 * @param {string} outDir
 * @returns {Promise<string>} путь к PDF
 */
function convertDocxToPdf(inPath, outDir) {
  const job = queue.then(async () => {
    await runConversion(inPath, outDir);
    const out = path.join(outDir, `${path.parse(inPath).name}.pdf`);
    if (!fs.existsSync(out)) throw new Error('Не удалось конвертировать документ: LibreOffice не создал PDF');
    return out;
  });
  queue = job.catch(() => {});
  return job;
}

async function inspectPdf(pdfBuffer) {
  try {
    const pdf = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    return { pageCount: pdf.getPageCount(), encrypted: pdf.isEncrypted };
  } catch (err) {
    // Зашифрованный PDF pdf-lib часто не может даже разобрать; словарь /Encrypt в файле всегда лежит открытым текстом.
    if (pdfBuffer.includes('/Encrypt')) return { pageCount: 0, encrypted: true };
    throw err;
  }
}

module.exports = { convertDocxToPdf, inspectPdf };
