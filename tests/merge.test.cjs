// PDF merge: files accumulate when added one by one, duplicates are skipped, order can change.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { PDFDocument } = require('pdf-lib');

module.exports = async ({ browser, base, dir }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/tools/pdf-workbench/'); await page.waitForFunction(() => window.PDFLib && window.pdfjsLib);
  const second = path.join(dir, 'second.pdf');
  const doc = await PDFDocument.create(); doc.addPage([300, 300]); doc.addPage([300, 300]); fs.writeFileSync(second, await doc.save());
  await page.locator('[data-tab=merge]').click();
  await page.locator('#mergeInput').setInputFiles(path.join(dir, 'input.pdf'));
  await page.locator('#mergeInput').setInputFiles(second);
  const rows = page.locator('#mergeList li:not(.file-list__head)');
  assert.equal(await rows.count(), 2, 'second pick adds instead of replacing');
  await page.locator('#mergeInput').setInputFiles(second);
  assert.equal(await rows.count(), 2, 'duplicate skipped'); assert.match(await page.locator('#resultTitle').innerText(), /이미 추가/);
  await page.waitForFunction(() => /총 6페이지/.test(document.querySelector('.file-list__head').textContent));
  await page.locator('#mergeList li:not(.file-list__head)').nth(1).getByRole('button', { name: /↑/ }).click();
  assert.match(await rows.first().innerText(), /second\.pdf/);
  const pending = page.waitForEvent('download'); await page.locator('#mergeRun').click();
  const file = path.join(dir, 'merged.pdf'); await (await pending).saveAs(file);
  const merged = await PDFDocument.load(fs.readFileSync(file)); assert.equal(merged.getPageCount(), 6); assert.equal(merged.getPage(0).getWidth(), 300);
  await page.getByRole('button', { name: '모두 지우기' }).click(); assert.equal(await rows.count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
};
