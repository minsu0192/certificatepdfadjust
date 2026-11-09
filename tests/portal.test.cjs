// Main page search/filters, every tool page at desktop and mobile width, and the support report download.
const assert = require('assert'); const fs = require('fs'); const path = require('path');

module.exports = async ({ browser, base, dir, shots }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const visibleCards = () => page.locator('.tool-card:visible').count();
  await page.goto(base + '/');
  assert.equal(await visibleCards(), 6);
  await page.locator('[data-category=invoice].category-tab').click(); assert.equal(await visibleCards(), 4);
  await page.locator('#toolSearch').fill('DHL'); assert.equal(await visibleCards(), 2);
  await page.locator('#toolSearch').fill('nothinghere'); assert(await page.locator('#emptyState').isVisible());
  await page.locator('#clearFilters').click(); assert.equal(await visibleCards(), 6);
  await page.locator('#toolSearch').fill('png'); assert.equal(await visibleCards(), 1);
  await page.locator('#toolSearch').fill('');
  await page.screenshot({ path: path.join(shots, 'portal-desktop.png'), fullPage: true });

  const links = await page.locator('.tool-card').evaluateAll(es => es.map(e => e.getAttribute('href')));
  for (const route of ['/', ...links, '/support/']) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + (route.startsWith('/') ? route : '/' + route), { waitUntil: 'networkidle' });
    assert.equal(await page.locator('h1').count(), 1, route);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'desktop overflow ' + route);
    if (route.includes('support')) {
      await page.locator('#reportError').fill('Test');
      const pending = page.waitForEvent('download'); await page.locator('#downloadReport').click();
      const file = path.join(dir, 'report.txt'); await (await pending).saveAs(file);
      assert(fs.readFileSync(file, 'utf8').includes('Test'));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile overflow ' + route);
    if (route === '/') await page.screenshot({ path: path.join(shots, 'portal-mobile.png'), fullPage: true });
  }
  assert.deepEqual(errors, []);
  await page.close();
};
