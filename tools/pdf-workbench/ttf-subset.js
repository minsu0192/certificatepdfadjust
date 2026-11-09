// Minimal TrueType subsetter used when saving edited PDFs.
// pdf-lib's built-in subsetting drops most Hangul glyphs of Pretendard, so instead we keep every glyph id
// (cmap/hmtx stay valid) and simply empty the outlines of glyphs that are not used. The result is small
// and is embedded with { subset: false }.
(function (root) {
  const KEEP = ['OS/2', 'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'post'];

  function subsetTrueType(input, glyphIds) {
    const src = Uint8Array.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input); // plain copy (Node Buffers share memory on slice)
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const tag = o => String.fromCharCode(src[o], src[o + 1], src[o + 2], src[o + 3]);
    const tables = {};
    for (let i = 0, n = view.getUint16(4); i < n; i++) {
      const r = 12 + i * 16; tables[tag(r)] = { offset: view.getUint32(r + 8), length: view.getUint32(r + 12) };
    }
    for (const t of ['head', 'maxp', 'loca', 'glyf', 'cmap', 'hmtx', 'hhea']) if (!tables[t]) throw new Error(`글꼴에 ${t} 테이블이 없습니다.`);
    const numGlyphs = view.getUint16(tables.maxp.offset + 4);
    const longLoca = view.getInt16(tables.head.offset + 50) === 1;
    const loca = i => longLoca ? view.getUint32(tables.loca.offset + i * 4) : view.getUint16(tables.loca.offset + i * 2) * 2;
    const glyf = tables.glyf.offset;

    // collect glyphs, following composite glyph components
    const keep = new Set([0]); const queue = [...glyphIds];
    while (queue.length) {
      const id = queue.pop(); if (id < 0 || id >= numGlyphs || keep.has(id)) continue; keep.add(id);
      const start = loca(id), end = loca(id + 1); if (end <= start) continue;
      if (view.getInt16(glyf + start) >= 0) continue;
      let p = glyf + start + 10, flags;
      do {
        flags = view.getUint16(p); queue.push(view.getUint16(p + 2)); p += 4 + (flags & 1 ? 4 : 2);
        p += flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0;
      } while (flags & 0x20);
    }

    // new glyf + long loca
    let size = 0; for (const id of keep) size += (loca(id + 1) - loca(id) + 3) & ~3;
    const newGlyf = new Uint8Array(size), newLoca = new DataView(new ArrayBuffer((numGlyphs + 1) * 4));
    let pos = 0;
    for (let id = 0; id < numGlyphs; id++) {
      newLoca.setUint32(id * 4, pos);
      if (!keep.has(id)) continue;
      const start = loca(id), end = loca(id + 1);
      if (end > start) { newGlyf.set(src.subarray(glyf + start, glyf + end), pos); pos += (end - start + 3) & ~3; }
    }
    newLoca.setUint32(numGlyphs * 4, pos);

    const out = {};
    for (const t of KEEP) if (tables[t]) out[t] = src.slice(tables[t].offset, tables[t].offset + tables[t].length);
    out.glyf = newGlyf.subarray(0, pos); out.loca = new Uint8Array(newLoca.buffer);
    const head = new DataView(out.head.buffer); head.setUint32(8, 0); head.setInt16(50, 1);
    if (out.post && out.post.length >= 32) { out.post = out.post.slice(0, 32); new DataView(out.post.buffer).setUint32(0, 0x00030000); }

    // assemble the sfnt
    const names = Object.keys(out).sort(), count = names.length;
    let offset = 12 + count * 16; const layout = names.map(n => { const o = offset; offset += (out[n].length + 3) & ~3; return o; });
    const font = new Uint8Array(offset), fv = new DataView(font.buffer);
    let pow = 1, log = 0; while (pow * 2 <= count) { pow *= 2; log++; }
    fv.setUint32(0, 0x00010000); fv.setUint16(4, count); fv.setUint16(6, pow * 16); fv.setUint16(8, log); fv.setUint16(10, count * 16 - pow * 16);
    const checksum = (bytes) => { let sum = 0; const padded = new Uint8Array((bytes.length + 3) & ~3); padded.set(bytes); const dv = new DataView(padded.buffer); for (let i = 0; i < padded.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0; return sum; };
    names.forEach((n, i) => {
      const r = 12 + i * 16; for (let k = 0; k < 4; k++) font[r + k] = n.charCodeAt(k);
      fv.setUint32(r + 4, checksum(out[n])); fv.setUint32(r + 8, layout[i]); fv.setUint32(r + 12, out[n].length); font.set(out[n], layout[i]);
    });
    fv.setUint32(layout[names.indexOf('head')] + 8, (0xB1B0AFBA - checksum(font)) >>> 0);
    return font;
  }

  if (typeof module === 'object' && module.exports) module.exports = subsetTrueType; else root.subsetTrueType = subsetTrueType;
})(typeof window !== 'undefined' ? window : globalThis);
