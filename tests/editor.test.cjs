// PDF workbench editor: page organisation, content tools, original-text editing, vector saving and permanent redaction.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { PDFDocument } = require('pdf-lib');

module.exports = async ({ browser, base, dir, shots }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(base + '/tools/pdf-workbench/'); await page.waitForFunction(() => window.PDFLib && window.pdfjsLib && window.fontkit);
  const ready = () => page.waitForFunction(() => document.querySelector('#editorWorkspace').getAttribute('aria-busy') === 'false');
  const click = async s => { await page.locator(s).click(); await ready(); };
  const label = i => page.locator('.page-card .page-label').nth(i).innerText();
  const count = () => page.locator('#editCount').innerText();
  // centroid of the red (#cc2233) pixels drawn on the overlay, in page coordinates
  const redPoint = () => page.evaluate(() => {
    const c = document.querySelector('#editOverlay'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let x = 0, y = 0, n = 0, maxX = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 140 && d[i + 1] < 90 && d[i + 2] < 110 && d[i + 3] > 100) { const px = (i / 4) % c.width; x += px; y += Math.floor(i / 4 / c.width); n++; maxX = Math.max(maxX, px); }
    const r = c.getBoundingClientRect(); return { x: r.x + x / n / c.width * r.width, y: r.y + y / n / c.height * r.height, n, maxX };
  });
  const save = async file => { const pending = page.waitForEvent('download'); await click('#editSave'); await (await pending).saveAs(file); return fs.readFileSync(file); };
  const pdfText = bytes => page.evaluate(async bytes => {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise; const out = [];
    for (let i = 1; i <= doc.numPages; i++) { const c = await (await doc.getPage(i)).getTextContent(); out.push(c.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))); }
    return out;
  }, Array.from(bytes));

  await page.locator('#editorInput').setInputFiles(path.join(dir, 'input.pdf')); await ready();

  // ---- page organisation ----
  assert.equal(await page.locator('#editorWorkspace').getAttribute('data-mode'), 'pages');
  assert(await page.locator('.editor-main').isHidden()); assert(await page.locator('#editBulk').isHidden(), 'bulk actions hidden without selection');
  await page.locator('.page-open').nth(1).click(); assert(await page.locator('#editBulk').isVisible());
  await page.locator('.page-open').nth(3).click({ modifiers: ['Shift'] }); assert.match(await count(), /3페이지/);
  await page.locator('.page-open').nth(2).click(); assert.match(await count(), /2페이지/);
  await click('#editFirst'); assert.match(await label(0), /원본 2/); assert.match(await label(1), /원본 4/);
  await click('#editOriginal'); assert.match(await label(0), /원본 1/);
  await click('#editReverse'); assert.match(await label(0), /원본 4/);
  await click('#editUndo'); assert.match(await label(0), /원본 1/);
  await page.locator('.page-card').nth(3).dragTo(page.locator('.page-card').nth(0), { targetPosition: { x: 5, y: 60 } }); await ready();
  assert.match(await label(0), /원본 2/); assert.match(await label(1), /원본 4/); assert.match(await label(2), /원본 1/, 'selected pages move as a group');
  await click('#editUndo'); await page.keyboard.press('Escape'); assert(await page.locator('#editBulk').isHidden());
  await page.locator('#editRange').fill('1'); await page.locator('#editRange').press('Enter'); await ready(); assert.match(await count(), /1페이지/);
  await page.keyboard.press('Escape');

  // ---- content mode, tools, live edits ----
  await page.locator('.page-open').nth(0).dblclick(); await ready();
  assert.equal(await page.locator('#editorWorkspace').getAttribute('data-mode'), 'content');
  assert(await page.locator('.page-tools').isHidden()); assert.equal(await page.locator('#editPageJump').inputValue(), '0');
  await page.locator('#editOverlay').focus(); await page.keyboard.press('t');
  assert.equal(await page.locator('#editTool').inputValue(), 'text');
  assert(await page.locator('#editTextField').isVisible()); assert(await page.locator('#editWidthField').isHidden()); assert(await page.locator('#editImageField').isHidden()); assert(await page.locator('#editRedactField').isHidden());
  await page.locator('#editText').fill('수정 전'); await page.locator('#editColor').fill('#cc2233');
  await page.locator('#editOverlay').click({ position: { x: 100, y: 200 } }); await ready();
  assert.equal(await page.locator('#editTool').inputValue(), 'select'); assert(await page.locator('#editSelection').isVisible());
  const a0 = await redPoint(); await page.locator('#editText').fill('수정 완료'); const a = await redPoint(); assert(a.n > 50);
  await page.locator('#editText').fill('수정 완료 더 긴 문장'); const b = await redPoint(); assert(b.maxX > a.maxX + 20, 'live text edit');
  await click('#editUndo'); let c = await redPoint(); assert(Math.abs(c.maxX - a0.maxX) < 2, 'one undo step reverts the typing session');
  await click('#editRedo'); c = await redPoint(); assert(c.maxX > a.maxX + 20, 'redo');
  await page.locator('#editOverlay').click({ position: { x: 5, y: 5 } }); await page.mouse.click(c.x, c.y);
  await page.locator('#editText').fill('수정 완료'); await page.locator('#editText').press('Enter'); c = await redPoint();
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 40, c.y + 30, { steps: 5 }); await page.mouse.up();
  const d = await redPoint(); assert(Math.abs(d.x - c.x - 40) < 2); assert(Math.abs(d.y - c.y - 30) < 2);
  await page.keyboard.press('ArrowRight'); assert((await redPoint()).x > d.x);
  const n1 = (await redPoint()).n; await page.keyboard.press('Control+d'); await ready(); assert((await redPoint()).n > n1 * 1.5, 'duplicate');
  await page.keyboard.press('Delete'); await ready(); assert(Math.abs((await redPoint()).n - n1) < n1 * 0.2, 'delete');
  // resize handle
  const rp = await redPoint(); await page.mouse.click(rp.x, rp.y);
  const sizeBefore = Number(await page.locator('#editSize').inputValue());
  const handle = await page.evaluate(() => {
    const c = document.querySelector('#editOverlay'), ctx = c.getContext('2d'), d = ctx.getImageData(0, 0, c.width, c.height).data; let x1 = 0, y1 = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 140 && d[i + 1] < 90 && d[i + 2] < 110 && d[i + 3] > 100) { x1 = Math.max(x1, (i / 4) % c.width); y1 = Math.max(y1, Math.floor(i / 4 / c.width)); }
    let best = null; for (let y = y1 - 10; y < y1 + 60; y++) for (let x = x1 - 10; x < x1 + 60; x++) { const p = ctx.getImageData(x, y, 1, 1).data; if (p[2] > 180 && p[0] < 120 && p[3] > 200) best = { x, y }; }
    const r = c.getBoundingClientRect(); return best && { x: r.x + best.x / c.width * r.width, y: r.y + best.y / c.height * r.height };
  });
  assert(handle, 'resize handle drawn');
  await page.mouse.move(handle.x - 2, handle.y - 2); await page.mouse.down(); await page.mouse.move(handle.x + 60, handle.y + 20, { steps: 6 }); await page.mouse.up();
  assert(Number(await page.locator('#editSize').inputValue()) > sizeBefore, 'resize grows text');
  await click('#editUndo');

  // ---- rotation keeps items editable; saved vector text matches the preview ----
  await click('#editModePages'); await page.locator('#editRange').fill('1'); await click('#editSelect'); await click('#editRotate');
  assert.match(await label(0), /90°/); assert.match(await page.locator('.page-badge').first().innerText(), /편집 1/);
  await click('#editModeContent'); let pt = await redPoint(); await page.mouse.click(pt.x, pt.y);
  assert.equal(await page.locator('#editText').inputValue(), '수정 완료'); assert.match(await page.locator('#editSelectionLabel').innerText(), /텍스트/);
  await page.locator('#editText').fill('회전 후 수정'); await page.locator('#editText').press('Enter');
  await page.locator('#editZoom').selectOption('150'); assert.equal(await page.locator('#editStage').evaluate(e => e.style.width), '150%');
  await page.locator('#editZoom').selectOption('fit'); assert.match(await page.locator('#editStage').evaluate(e => e.style.width), /min\(/);
  await page.keyboard.press('Escape');
  let bytes = await save(path.join(dir, 'out1.pdf'));
  let out = await PDFDocument.load(bytes); assert.equal(out.getPage(0).getRotation().angle, 90); assert.equal(out.getPageCount(), 4);
  const cmp = await page.evaluate(async bytes => {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise; const p = await doc.getPage(1); const v = p.getViewport({ scale: 1.5 });
    const c = document.createElement('canvas'); c.width = Math.ceil(v.width); c.height = Math.ceil(v.height); await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    const s = c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let x = 0, y = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 140 && d[i + 1] < 90 && d[i + 2] < 110 && d[i + 3] > 100) { x += (i / 4) % c.width; y += Math.floor(i / 4 / c.width); n++; } return { x: x / n, y: y / n, n }; };
    return { saved: s(c), preview: s(document.querySelector('#editOverlay')) };
  }, Array.from(bytes));
  assert(cmp.saved.n > 50); assert(Math.abs(cmp.saved.x - cmp.preview.x) < 3, 'saved x matches preview'); assert(Math.abs(cmp.saved.y - cmp.preview.y) < 3, 'saved y matches preview');
  let text = await pdfText(bytes);
  assert(text[0].some(t => t.str.includes('회전 후 수정')), 'Korean text is saved as real, searchable text');

  // ---- image tool ----
  await page.keyboard.press('i'); assert(await page.locator('#editImageField').isVisible()); assert(await page.locator('#editSizeField').isHidden());
  await page.locator('#editImage').setInputFiles(path.join(dir, 'stamp.png')); await ready();
  let box = await page.locator('#editOverlay').boundingBox();
  await page.mouse.move(box.x + 70, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 150, box.y + 340); await page.mouse.up(); await ready();
  assert.match(await page.locator('#editSelectionLabel').innerText(), /이미지/); assert(await page.locator('#editImageField').isHidden());
  await page.locator('#editObjectWidth').fill('80'); await page.locator('#editObjectWidth').press('Tab'); assert.equal(await page.locator('#editObjectWidth').inputValue(), '80');

  // ---- original text editing (원문 수정) on page 2 ----
  await page.locator('#editOverlay').focus(); await page.keyboard.press('PageDown'); await ready(); assert.equal(await page.locator('#editPageJump').inputValue(), '1');
  await page.keyboard.press('r'); await ready(); assert.equal(await page.locator('#editTool').inputValue(), 'retext');
  box = await page.locator('#editOverlay').boundingBox(); const at = (x, y) => ({ x: box.x + x / 595 * box.width, y: box.y + y / 842 * box.height });
  const run = at(110, 842 - 700 - 4); await page.mouse.move(run.x, run.y); await page.mouse.click(run.x, run.y); await ready();
  assert.equal(await page.locator('#editText').inputValue(), 'Invoice total 1,234.00', 'picked up the original text');
  assert.equal(Number(await page.locator('#editSize').inputValue()), 14, 'picked up the original size');
  const color = await page.locator('#editColor').inputValue(); assert(parseInt(color.slice(5, 7), 16) > parseInt(color.slice(1, 3), 16), 'picked up the original (blue) colour ' + color);
  assert(await page.locator('#editText').evaluate(e => e === document.activeElement), 'text box focused for typing');
  await page.keyboard.type('Invoice total 9,999.00'); await page.keyboard.press('Enter');
  bytes = await save(path.join(dir, 'out2.pdf')); text = await pdfText(bytes);
  const replaced = text[1].find(t => t.str.includes('9,999.00')); assert(replaced, 'replacement is real text');
  assert(Math.abs(replaced.x - 60) < 1.5 && Math.abs(replaced.y - 700) < 1.5, `replacement sits on the original baseline (${replaced.x}, ${replaced.y})`);
  assert(text[1].some(t => t.str.includes('1,234.00')), 'plain cover keeps the original text in the file (documented)');

  // ---- permanent redaction on page 2 ----
  await page.locator('#editOverlay').focus(); await page.keyboard.press('e'); assert(await page.locator('#editRedactField').isVisible());
  await page.locator('#editRedact').check();
  box = await page.locator('#editOverlay').boundingBox(); assert(await page.locator('#editMessage').evaluate(e => getComputedStyle(e).position === 'fixed'), 'messages do not shift the layout');
  const r0 = at(50, 842 - 805), r1 = at(260, 842 - 690);
  await page.mouse.move(r0.x, r0.y); await page.mouse.down(); await page.mouse.move(r1.x, r1.y, { steps: 4 }); await page.mouse.up(); await ready();
  assert.match(await page.locator('#editSelectionLabel').innerText(), /영구 삭제/);
  await page.keyboard.press('t'); await page.locator('#editText').fill('승인 완료 OK'); await page.locator('#editColor').fill('#cc2233');
  const later = at(80, 400); await page.mouse.click(later.x, later.y); await ready(); await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(shots, 'editor-content.png'), fullPage: true });
  bytes = await save(path.join(dir, 'out3.pdf')); text = await pdfText(bytes);
  assert(!text[1].some(t => /Page 2|1,234\.00|9,999\.00/.test(t.str)), 'redacted page no longer contains the original text or text hidden under the redaction');
  assert(text[1].some(t => t.str.includes('승인 완료 OK')), 'items added after the redaction stay as real text');
  assert(text[2].some(t => t.str.includes('Page 3')), 'other pages untouched');
  assert(bytes.length < 1500000, `file stays small with a font subset (${bytes.length} bytes)`);
  assert.match(await page.locator('#editMessage').innerText(), /이미지로 저장/);

  // ---- mobile layouts ----
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile content overflow');
  await page.screenshot({ path: path.join(shots, 'editor-mobile.png'), fullPage: true });
  await click('#editModePages'); assert(await page.locator('.editor-main').isHidden());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile pages overflow');
  assert.deepEqual(errors, []);
  await page.close();
};
