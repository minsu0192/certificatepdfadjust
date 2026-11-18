const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, PDFName } = require('pdf-lib');
const JSZip = require('../vendor/jszip.min.js');

module.exports = async ({ browser, base, dir }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const second = await PDFDocument.create();
  const font = await second.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) second.addPage().drawText('Invoice total 5678.00', { x: 40, y: 700, font });
  const secondBytes = Buffer.from(await second.save());
  const firstBytes = fs.readFileSync(path.join(dir, 'input.pdf'));
  const twoNamedFiles = [firstBytes, secondBytes].map(buffer => ({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer }));
  async function download(button, name) {
    const pending = page.waitForEvent('download'); await page.locator(button).click();
    const target = path.join(dir, name); await (await pending).saveAs(target); return fs.readFileSync(target);
  }
  await page.goto(base + '/tools/pdf-workbench/');
  await page.locator('[data-tab=compress]').click();
  await page.locator('#compressInput').setInputFiles(twoNamedFiles);
  const compressed = await JSZip.loadAsync(await download('#compressRun', 'duplicates-compressed.zip'));
  assert.equal(Object.keys(compressed.files).length, 2, 'both same-name inputs survive ZIP export');
  const pageCounts = [];
  for (const item of Object.values(compressed.files)) pageCounts.push((await PDFDocument.load(await item.async('uint8array'))).getPageCount());
  assert.deepEqual(pageCounts.sort(), [2, 4]);

  await page.locator('[data-tab=merge]').click();
  await page.locator('#mergeInput').setInputFiles(twoNamedFiles);
  assert.equal((await PDFDocument.load(await download('#mergeRun', 'reliable-merged.pdf'))).getPageCount(), 6);
  const items = page.locator('#mergeList li:not(.file-list__head)');
  assert(await items.first().getByRole('button', { name: /↑/ }).isDisabled(), 'first move-up remains disabled after work');
  assert(await items.last().getByRole('button', { name: /↓/ }).isDisabled(), 'last move-down remains disabled after work');
  await items.last().getByRole('button', { name: /↑/ }).click();
  assert.equal(await items.count(), 2);

  await page.locator('[data-tab=ocr]').click();
  await page.locator('#ocrInput').setInputFiles(twoNamedFiles);
  const ocr = await JSZip.loadAsync(await download('#ocrRun', 'duplicates-ocr.zip'));
  assert.equal(Object.keys(ocr.files).length, 2, 'OCR also preserves same-name inputs');

  // A document flagged as encrypted is refused before copying its streams.
  const encrypted = await PDFDocument.create(); encrypted.addPage();
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: PDFName.of('Standard') }));
  await page.locator('[data-tab=compress]').click();
  await page.getByRole('button', { name: '모두 지우기' }).click();
  await page.locator('#compressInput').setInputFiles({ name: 'encrypted.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await encrypted.save()) });
  await page.locator('#compressRun').click();
  await page.waitForFunction(() => /잠금 해제/.test(document.querySelector('#resultDetail').textContent), null, { timeout: 10000 }).catch(async error => { throw new Error(error.message + '\n' + await page.locator('#resultCard').textContent() + '\n' + await page.locator('#compressList').textContent()); });
  await page.locator('#compressMode').selectOption('optimize');
  await page.locator('#compressRun').click();
  await page.waitForFunction(() => /잠금 해제/.test(document.querySelector('#resultDetail').textContent));

  // Cancel an OCR engine which has not yet produced a response.
  const blank = await PDFDocument.create(); blank.addPage();
  await page.locator('[data-tab=ocr]').click();
  await page.getByRole('button', { name: '모두 지우기' }).click();
  await page.evaluate(() => {
    window.Tesseract = { createWorker: async () => ({ recognize: () => { window.ocrStarted = true; return new Promise(() => {}); }, terminate: async () => {} }) };
  });
  await page.locator('#ocrInput').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await blank.save()) });
  await page.locator('#ocrRun').click(); await page.waitForFunction(() => window.ocrStarted);
  await page.locator('#cancelTask').click();
  await page.waitForFunction(() => document.querySelector('#resultTitle').textContent === '작업 취소됨');
  assert(await page.locator('#ocrRun').isEnabled());
  assert.equal(await page.locator('[role=status]').evaluateAll(es => es.some(e => !e.hidden && /글자 인식.*%/.test(e.textContent))), false);

  // Exact monetary field values must never be replaced by another line's labelled total.
  for (const tool of ['fedex-dhl-extractor', 'dhl-pdf-extractor']) {
    await page.goto(base + '/tools/' + tool + '/');
    const result = await page.evaluate(() => ({
      small: amountNear('Korea VAT 800\nTotal 12,345', /Korea\s*VAT/i),
      zero: amountNear('Korea VAT 0\nTotal 12,345', /Korea\s*VAT/i),
      missing: amountNear('Korea VAT\nTotal 12,345', /Korea\s*VAT/i),
      nextLine: amountNear('Korea VAT\nKRW 800', /Korea\s*VAT/i),
      total: amountNear('Grand Total 1,234.00\nInvoice Number 7-123-12345', /Grand\s*Total/i),
      repeated: amountNear('VAT Reg No. 123-45-67890\nVAT (10%) 1,234', /\bVAT\b/i),
      currency: amountNear('Total (KRW) 12,345', /Total/i),
      ratedNext: amountNear('VAT (10%)\n1,234', /VAT/i),
      spaced: amountNear('VAT 1 234 567', /VAT/i),
      ambiguous: amountNear('VAT 800 1,234', /VAT/i),
      tax: (() => { const parsed = parseDhlEtradebill('승인번호 1234567890123456\n작성일자 2026-11-18\nVAT 10%', 'test.pdf', 'PDF Text'); return (parsed.summaries || parsed.rows)[0]; })(),
    }));
    assert.equal(result.small, 800); assert.equal(result.zero, 0); assert.equal(result.missing, null); assert.equal(result.nextLine, 800); assert.equal(result.total, 1234);
    assert.equal(result.repeated, 1234); assert.equal(result.currency, 12345); assert.equal(result.spaced, 1234567); assert.equal(result.ambiguous, null);
    assert.equal(result.ratedNext, 1234);
    assert(!Object.values(result.tax).includes('Zero Rated'), tool + ' must not treat 10% as zero rated');
    if (tool === 'dhl-pdf-extractor') assert.notStrictEqual(result.tax['세액'], 0, 'missing VAT must not silently become zero');
    if (tool === 'fedex-dhl-extractor') assert.equal(await page.evaluate(() => sumAmountsForLabel('Korea VAT 800\nTotal 12,345\nKorea VAT 0', /Korea\s*VAT/i)), 800);
  }

  await page.goto(base + '/tools/import-certificate/');
  const extracted = await page.evaluate(() => {
    const warnings = [];
    const items = extractItemLines('(NO. 01)\n1 EA 400 400\n(NO. 02)\n1 EA 100 900\n(NO. 03)\n잘못된 품목', s => warnings.push(s));
    const small = extractItemLines('PART 1 EA 214 214');
    const zero = extractItemLines('(NO. 01)\n1 EA 0 0');
    return { items, warnings, small, zero, invalid: parseKoreanNumber('broken') };
  });
  assert.equal(extracted.items.length, 1); assert.equal(extracted.items[0].totalAmount, 400);
  assert.equal(extracted.warnings.length, 2); assert(extracted.warnings.some(s => s.includes('02'))); assert(extracted.warnings.some(s => s.includes('03')));
  assert.equal(extracted.small[0].totalAmount, 214); assert.equal(extracted.zero[0].totalAmount, 0); assert.equal(extracted.invalid, null);

  await page.goto(base + '/tools/ai-table/');
  assert(await page.locator('#cancelImport').isHidden());
  await page.evaluate(() => {
    const zone = document.getElementById('pdfDropZone');
    for (const [name, type] of [['old.pdf', 'application/pdf'], ['new.txt', 'text/plain']]) {
      const data = new DataTransfer(); data.items.add(new File(['x'], name, { type }));
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }
  });
  assert.equal(await page.locator('#pdfFile').evaluate(e => e.files.length), 0);
  await page.locator('#source').fill('AWB,연도,금액\n1234567890,2026,1234');
  await page.locator('#textColumns').fill('1,2'); await page.locator('#preview').click();
  const xlsx = require('../tools/ai-table/vendor/xlsx.min.js');
  const sheet = xlsx.read(await download('#excel', 'identifiers.xlsx'), { type: 'buffer' }).Sheets['표'];
  assert.equal(sheet.A2.t, 's'); assert.equal(sheet.A2.v, '1234567890'); assert.equal(sheet.B2.t, 's'); assert.equal(sheet.C2.t, 'n');

  // A failed OCR page should not discard another page's usable text.
  const mixed = await PDFDocument.load(firstBytes); mixed.addPage();
  await page.evaluate(() => { ToolOcr.recognise = async () => { throw new Error('engine unavailable'); }; });
  await page.locator('#pdfFile').setInputFiles({ name: 'mixed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await mixed.save()) });
  await page.locator('#importPdf').click();
  await page.waitForFunction(() => !document.querySelector('#importPdf').hasAttribute('aria-busy'));
  assert.match(await page.locator('#importStatus').textContent(), /OCR 실패: 5페이지/);
  assert.match(await page.locator('#source').inputValue(), /Invoice/);

  await page.goto(base + '/support/?tool=ai-table');
  assert.equal(await page.locator('#reportTool').inputValue(), 'CSV · PDF 형식 변환');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } }));
  await page.locator('#copyReport').click(); assert.match(await page.locator('#reportStatus').textContent(), /TXT 다운로드/);
  await page.goto(base + '/tools/pdf-workbench/');
  await page.locator('#editorInput').setInputFiles(path.join(dir, 'input.pdf'));
  const ready = () => page.waitForFunction(() => document.querySelector('#editorWorkspace').getAttribute('aria-busy') === 'false');
  await ready(); await page.locator('.page-open').first().click(); await page.locator('#editRotate').click(); await ready();
  const savedCount = () => page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('pdf-workbench-editor', 1); req.onerror = () => reject(req.error);
    req.onsuccess = () => { const db = req.result; const q = db.transaction('session').objectStore('session').count(); q.onsuccess = () => { const n = q.result; db.close(); resolve(n); }; };
  }));
  await page.waitForTimeout(1100); assert.equal(await savedCount(), 2, 'source and state are saved together');
  const other = await context.newPage(); await other.goto(base + '/tools/pdf-workbench/');
  await other.waitForFunction(() => document.querySelector('#editAutosave').disabled);
  assert(!(await other.locator('#editAutosave').isChecked()));
  assert(await other.locator('#editClearStorage').isDisabled());
  await other.locator('#editorInput').setInputFiles(path.join(dir, 'input.pdf'));
  await other.waitForFunction(() => document.querySelector('#editorWorkspace').getAttribute('aria-busy') === 'false');
  const otherDownload = other.waitForEvent('download'); await other.locator('#editSave').click(); await otherDownload;
  assert.equal(await savedCount(), 2, 'saving another tab cannot delete this tab’s recovery data'); await other.close();
  await download('#editSave', 'storage-cleanup.pdf'); await ready();
  assert.equal(await savedCount(), 0, 'full export removes the retained original');
  await page.locator('#editRotate').click(); await ready(); await page.waitForTimeout(1100);
  assert.equal(await savedCount(), 2);
  await page.locator('#editClearStorage').click(); await ready();
  assert.equal(await savedCount(), 0); assert.equal(await page.locator('.page-card').count(), 4, 'clearing storage keeps the open document');
  assert(!(await page.locator('#editAutosave').isChecked()));
  // Avoid beforeunload prompts from intentionally unsaved edits at test shutdown.
  page.on('dialog', dialog => dialog.accept());
  assert.deepEqual(errors, []); await context.close();

  const fresh = await browser.newContext(); const direct = await fresh.newPage();
  await direct.goto(base + '/tools/ai-table/');
  await direct.evaluate(() => navigator.serviceWorker.ready);
  assert.equal(await direct.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 1);
  await fresh.setOffline(true); await direct.reload(); assert.equal(await direct.locator('h1').textContent(), 'CSV · PDF 형식 변환');
  assert(await direct.evaluate(async () => (await fetch('/tools/pdf-workbench/vendor/qpdf/qpdf.wasm')).ok), 'unlock WASM is prepared before going offline');
  await fresh.close();
};
