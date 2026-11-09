// Generates the sample files used by the browser tests.
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b, 255], y * (w * 4 + 1) + 1 + x * 4);
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const x of buf) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = async function makeFixtures(dir) {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${i}`, { x: 60, y: 760, size: 36, font, color: rgb(0, 0, 0) });
    page.drawText('Invoice total 1,234.00', { x: 60, y: 700, size: 14, font, color: rgb(0.1, 0.2, 0.5) });
  }
  fs.writeFileSync(path.join(dir, 'input.pdf'), await doc.save());
  fs.writeFileSync(path.join(dir, 'stamp.png'), png(40, 20, [20, 60, 200]));
};
