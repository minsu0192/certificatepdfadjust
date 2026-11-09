// Usage: npm test  — serves the site locally and runs every *.test.cjs in this folder against it.
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { chromium } = require('playwright');
const makeFixtures = require('./fixtures.cjs');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-tools-test-'));
  const shots = path.join(root, 'test-results'); fs.mkdirSync(shots, { recursive: true });
  await makeFixtures(dir);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const only = process.argv[2];
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.cjs') && (!only || f.includes(only))).sort();
  let failed = 0;
  for (const file of files) {
    const started = Date.now();
    try { await require(path.join(__dirname, file))({ browser, base, dir, shots }); console.log(`PASS ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)`); }
    catch (e) { failed++; console.error(`FAIL ${file}\n`, e); }
  }
  await browser.close(); server.close(); if (process.env.KEEP_FIXTURES) console.log(`fixtures kept in ${dir}`); else fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
