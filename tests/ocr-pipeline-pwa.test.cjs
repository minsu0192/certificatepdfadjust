// Round 3: OCR for scanned PDFs (workbench tab, editor, shared helper), handing results between tools,
// and the installable/offline app shell.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { PDFDocument } = require('pdf-lib');

module.exports = async ({ browser, base, dir, shots }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  const ready = () => page.waitForFunction(() => document.querySelector('#editorWorkspace').getAttribute('aria-busy') === 'false');
  const workbench = async () => { await page.goto(base + '/tools/pdf-workbench/'); await page.waitForFunction(() => window.PDFLib && window.pdfjsLib && window.fontkit && window.ToolOcr); };
  const pdfText = bytes => page.evaluate(async bytes => {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise; const out = [];
    for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map(it => it.str).join(' '));
    return out;
  }, Array.from(bytes));

  // ---- build a "scanned" PDF: a picture of text, no text layer ----
  await workbench();
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1240; c.height = 1754; const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = '#111';
    ctx.font = '600 64px Arial'; ctx.fillText('INVOICE TOTAL 1234.00', 120, 300);
    ctx.font = '48px Arial'; ctx.fillText('Shipment number 7788', 120, 460);
    return c.toDataURL('image/png').split(',')[1];
  });
  const scan = await PDFDocument.create(); const img = await scan.embedPng(Buffer.from(png, 'base64'));
  scan.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  const scanned = path.join(dir, 'scanned.pdf'); fs.writeFileSync(scanned, await scan.save());

  // ---- OCR tab: searchable PDF ----
  await page.locator('[data-tab=ocr]').click();
  await page.locator('#ocrInput').setInputFiles(scanned); await page.locator('#ocrLang').selectOption('eng');
  let pending = page.waitForEvent('download', { timeout: 120000 }); await page.locator('#ocrRun').click();
  const ocrFile = path.join(dir, 'scanned_ocr.pdf'); await (await pending).saveAs(ocrFile);
  const ocrBytes = fs.readFileSync(ocrFile); const words = (await pdfText(ocrBytes))[0];
  assert(/INVOICE/.test(words) && /1234\.00/.test(words), 'OCR text is searchable: ' + words);
  assert.match(await page.locator('#resultDetail').innerText(), /1페이지 인식/);

  // ---- hand the result to the editor without downloading ----
  await page.locator('[data-next=editor]').click(); await ready();
  assert(await page.locator('[data-panel=editor]').isVisible()); assert.equal(await page.locator('.page-card').count(), 1);

  // ---- editor: 원문 수정 on a scanned page finds text via OCR ----
  await workbench(); await page.locator('#editorInput').setInputFiles(scanned); await ready();
  await page.locator('.page-open').first().dblclick(); await ready();
  await page.locator('#editOverlay').focus(); await page.keyboard.press('r');
  await page.waitForFunction(() => document.querySelector('#editorWorkspace').getAttribute('aria-busy') === 'false', null, { timeout: 120000 });
  const box = await page.locator('#editOverlay').boundingBox();
  const at = (x, y) => ({ x: box.x + x / 1240 * box.width, y: box.y + y / 1754 * box.height });
  const target = at(300, 280); await page.mouse.move(target.x, target.y); await page.mouse.click(target.x, target.y); await ready();
  assert.match(await page.locator('#editText').inputValue(), /INVOICE/, 'scanned text picked up for editing');

  // ---- editor → merge via "보내기" ----
  await page.keyboard.press('Escape');
  await page.locator('#editSendTo').selectOption('merge');
  await page.waitForFunction(() => document.querySelector('[data-panel=merge]').classList.contains('is-active') && document.querySelectorAll('#mergeList li:not(.file-list__head)').length === 1);
  // merge result → compress
  await page.locator('#mergeInput').setInputFiles(path.join(dir, 'input.pdf'));
  pending = page.waitForEvent('download'); await page.locator('#mergeRun').click(); await pending;
  await page.locator('[data-next=compress]').click();
  assert(await page.locator('[data-panel=compress]').isVisible());
  assert.match(await page.locator('#compressList').innerText(), /merged\.pdf/);

  // ---- shared OCR helper used by the extractor tools ----
  await page.goto(base + '/tools/celine-credit-note/'); await page.waitForFunction(() => window.ToolOcr && window.pdfjsLib);
  const helper = await page.evaluate(async bytes => {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise; const content = await ToolOcr.pageContent(await doc.getPage(1), { lang: 'eng' });
    return { ocr: !!content.ocr, text: content.items.map(it => it.str).join(' '), y: content.items.map(it => Math.round(it.transform[5])) };
  }, Array.from(fs.readFileSync(scanned)));
  assert(helper.ocr && /Shipment number 7788/.test(helper.text), 'helper OCR: ' + helper.text);
  assert(helper.y.some(y => Math.abs(y - (842 - 300 * 842 / 1754)) < 8), 'OCR items are placed in PDF coordinates');
  assert.deepEqual(errors, []);
  await context.close();

  // ---- installable app and offline use ----
  const app = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ap = await app.newPage();
  await ap.goto(base + '/');
  const manifest = await ap.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  assert.equal(manifest.display, 'standalone'); assert(manifest.icons.some(i => i.sizes === '512x512'));
  await ap.evaluate(() => navigator.serviceWorker.ready);
  await ap.goto(base + '/tools/pdf-workbench/'); await ap.waitForFunction(() => navigator.serviceWorker.controller && window.PDFLib && window.pdfjsLib);
  await ap.waitForTimeout(500);
  await app.setOffline(true);
  await ap.reload(); await ap.waitForFunction(() => window.PDFLib && window.pdfjsLib, null, { timeout: 15000 });
  assert.match(await ap.title(), /워크스페이스/, 'workbench opens offline');
  await ap.goto(base + '/tools/import-certificate/'); assert.equal(await ap.locator('h1').count(), 1, 'other tools are precached for offline use');
  await app.setOffline(false); await app.close();
};
