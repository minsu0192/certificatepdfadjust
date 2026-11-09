// Editor round 2: inserting pages, lazy thumbnails, signatures & stamp library, copy to pages,
// page numbers, watermark, crop, autosave/restore and touch reordering.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { PDFDocument } = require('pdf-lib');

module.exports = async ({ browser, base, dir, shots }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  const open = async () => { await page.goto(base + '/tools/pdf-workbench/'); await page.waitForFunction(() => window.PDFLib && window.pdfjsLib && window.fontkit); };
  const ready = () => page.waitForFunction(() => document.querySelector('#editorWorkspace').getAttribute('aria-busy') === 'false');
  const click = async s => { await page.locator(s).click(); await ready(); };
  const label = i => page.locator('.page-card .page-label').nth(i).innerText();
  const save = async name => { const pending = page.waitForEvent('download'); await click('#editSave'); const file = path.join(dir, name); await (await pending).saveAs(file); return fs.readFileSync(file); };
  const pdfText = bytes => page.evaluate(async bytes => {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise; const out = [];
    for (let i = 1; i <= doc.numPages; i++) { const c = await (await doc.getPage(i)).getTextContent(); out.push(c.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))); }
    return out;
  }, Array.from(bytes));

  await open();
  await page.evaluate(() => localStorage.clear());
  await page.locator('#editorInput').setInputFiles(path.join(dir, 'input.pdf')); await ready();

  // ---- lazy thumbnails fill in ----
  await page.waitForFunction(() => [...document.querySelectorAll('.page-thumb img')].every(img => img.getAttribute('src')));

  // ---- insert a blank page after page 2, then another PDF after it ----
  await page.locator('.page-open').nth(1).click();
  await click('#editInsertBlank');
  assert.equal(await page.locator('.page-card').count(), 5); assert.match(await label(2), /빈 페이지/);
  await page.locator('#editInsertInput').setInputFiles(path.join(dir, 'input.pdf')); await ready();
  assert.equal(await page.locator('.page-card').count(), 9); assert.match(await label(3), /input 1/); assert.match(await label(8), /원본 4/);
  await click('#editUndo'); assert.equal(await page.locator('.page-card').count(), 5); await click('#editRedo');
  await page.keyboard.press('Escape');

  // ---- page numbers (all pages) and watermark (selected pages) ----
  await page.locator('#editPageNumbers').click(); assert(await page.locator('#batchDialog').isVisible());
  await page.locator('#numFormat').selectOption('{n} / {total}'); await click('#batchApply');
  assert(!(await page.locator('#batchDialog').isVisible()));
  await page.locator('.page-open').nth(0).click();
  await page.locator('#editWatermark').click(); assert.equal(await page.locator('#batchTarget').inputValue(), 'selected');
  await page.locator('#wmText').fill('CONFIDENTIAL'); await click('#batchApply');
  // re-applying numbers replaces them instead of duplicating
  await page.locator('#editPageNumbers').click(); await page.locator('#batchTarget').selectOption('all'); await click('#batchApply');
  assert.match(await page.locator('.page-badge').first().innerText(), /편집 2/);
  await page.keyboard.press('Escape');

  // ---- signature: draw, save to library, click to place, copy to all pages ----
  await page.locator('.page-open').nth(0).dblclick(); await ready();
  await page.locator('#editOverlay').focus(); await page.keyboard.press('i');
  await page.locator('#editSignDraw').click(); assert(await page.locator('#signDialog').isVisible());
  await click('#signUse'); assert(await page.locator('#signError').isVisible(), 'empty signature rejected');
  const pad = await page.locator('#signPad').boundingBox();
  await page.mouse.move(pad.x + 40, pad.y + 100); await page.mouse.down();
  for (let k = 1; k <= 12; k++) await page.mouse.move(pad.x + 40 + k * 30, pad.y + 100 + Math.sin(k) * 40);
  await page.mouse.up(); await click('#signUse');
  assert(!(await page.locator('#signDialog').isVisible()));
  assert.equal(await page.locator('#editStamps .stamp').count(), 1);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pdfWorkbench.stamps.v1')).length), 1, 'signature kept in this browser');
  const ov = await page.locator('#editOverlay').boundingBox();
  await page.mouse.click(ov.x + ov.width * .7, ov.y + ov.height * .8); await ready();
  assert.match(await page.locator('#editSelectionLabel').innerText(), /이미지/);
  assert(Number(await page.locator('#editObjectWidth').inputValue()) > 50, 'click places the signature at a default size');
  await page.locator('#editCopyPages').click(); await page.locator('#editCopyRange').fill(''); await click('#editCopyApply');
  assert.match(await page.locator('.page-badge').nth(4).innerText(), /편집 2/, 'copied to the last page');

  let bytes = await save('round2.pdf'); let text = await pdfText(bytes);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 9);
  assert(text[1].some(t => t.str === '2 / 9' && t.y < 60 && Math.abs(t.x - (595 / 2 - 10)) < 20), 'page number at the bottom centre');
  assert(text.every((items, i) => items.filter(t => t.str === `${i + 1} / 9`).length === 1), 'exactly one page number per page');
  assert(text[0].some(t => t.str === 'CONFIDENTIAL')); assert(!text[1].some(t => t.str === 'CONFIDENTIAL'), 'watermark only on the selected page');

  // ---- crop page 1 ----
  await page.keyboard.press('Escape'); await page.locator('#editOverlay').focus(); await page.keyboard.press('c');
  assert(await page.locator('#editCropField').isVisible());
  await page.mouse.move(ov.x + ov.width * .05, ov.y + ov.height * .05); await page.mouse.down();
  await page.mouse.move(ov.x + ov.width * .95, ov.y + ov.height * .55, { steps: 4 }); await page.mouse.up();
  assert.match(await label(0), /자름/);
  await page.screenshot({ path: path.join(shots, 'editor-round2.png'), fullPage: true });
  bytes = await save('round2-crop.pdf');
  const crop = (await PDFDocument.load(bytes)).getPage(0).getCropBox();
  assert(Math.abs(crop.width - 595 * .9) < 4 && Math.abs(crop.height - 842 * .5) < 6, `crop box ${JSON.stringify(crop)}`);

  // ---- autosave survives a reload (only unsaved work is offered) ----
  await page.waitForTimeout(1000); await open();
  assert(await page.locator('#editRestore').isHidden(), 'nothing offered right after saving');
  await page.locator('#editorInput').setInputFiles(path.join(dir, 'input.pdf')); await ready();
  await page.locator('.page-open').nth(0).click(); await click('#editInsertBlank');
  await page.locator('#editPageNumbers').click(); await page.locator('#batchTarget').selectOption('all'); await click('#batchApply');
  await page.waitForTimeout(1200); await open();
  assert(await page.locator('#editRestore').isVisible(), 'restore offered after reload');
  await click('#editRestoreYes');
  assert.equal(await page.locator('.page-card').count(), 5); assert.match(await label(1), /빈 페이지/);
  assert.match(await page.locator('.page-badge').nth(4).innerText(), /편집 1/);
  await page.waitForFunction(() => [...document.querySelectorAll('.page-thumb img')].every(img => img.getAttribute('src')));
  assert.deepEqual(errors, []);
  await context.close();

  // ---- touch: long-press then drag a page ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const tp = await phone.newPage(); tp.on('pageerror', e => errors.push(e.message)); tp.on('dialog', d => d.dismiss());
  await tp.goto(base + '/tools/pdf-workbench/'); await tp.waitForFunction(() => window.PDFLib && window.pdfjsLib);
  if (await tp.locator('#editRestore').isVisible()) await tp.locator('#editRestoreNo').click();
  await tp.locator('#editorInput').setInputFiles(path.join(dir, 'input.pdf'));
  await tp.waitForFunction(() => document.querySelectorAll('.page-card').length === 4 && document.querySelector('#editorWorkspace').getAttribute('aria-busy') === 'false');
  await tp.locator('.page-card').nth(3).scrollIntoViewIfNeeded();
  const from = await tp.locator('.page-card').nth(3).boundingBox(), to = await tp.locator('.page-card').nth(0).boundingBox();
  await tp.evaluate(async ({ from, to }) => {
    const el = document.elementFromPoint(from.x + from.width / 2, from.y + from.height / 2);
    const touch = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    const fire = (type, x, y) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch(x, y)], changedTouches: [touch(x, y)] }));
    fire('touchstart', from.x + from.width / 2, from.y + from.height / 2);
    await new Promise(r => setTimeout(r, 450));
    for (let k = 1; k <= 6; k++) fire('touchmove', from.x + (to.x + 8 - from.x) * k / 6, from.y + from.height / 2 + (to.y + to.height / 2 - from.y - from.height / 2) * k / 6);
    fire('touchend', to.x + 8, to.y + to.height / 2);
  }, { from, to });
  await tp.waitForFunction(() => document.querySelector('#editorWorkspace').getAttribute('aria-busy') === 'false' && /원본 4/.test(document.querySelector('.page-card .page-label').textContent));
  assert.equal(await tp.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await tp.screenshot({ path: path.join(shots, 'editor-touch.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await phone.close();
};
