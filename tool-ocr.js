// Shared OCR helper for scanned PDFs (runs entirely in the browser with tesseract.js).
// pageContent(page) returns the same shape as pdf.js getTextContent(): { items: [{ str, transform, width, height }] }.
// If the page already has real text it is returned unchanged; otherwise the page is rendered and recognised,
// and each recognised phrase becomes an item positioned in PDF coordinates, so existing parsers keep working.
(function () {
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const MIN_CHARS = 12;
  let loader = null, workers = new Map(), banner = null, active = 0;

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    return loader ||= new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = TESSERACT_URL; script.async = true;
      script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR 엔진을 불러오지 못했습니다.'));
      script.onerror = () => { loader = null; reject(new Error('OCR 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하세요.')); };
      document.head.appendChild(script);
    });
  }
  async function worker(lang) {
    if (!workers.has(lang)) {
      workers.set(lang, (async () => {
        const T = await loadTesseract();
        return T.createWorker(lang, 1, { logger: m => { if (m.status === 'recognizing text') status(`스캔 문서 글자 인식 중 ${Math.round((m.progress || 0) * 100)}%`); else if (m.status) status('글자 인식 준비 중…'); } });
      })().catch(e => { workers.delete(lang); throw e; }));
    }
    return workers.get(lang);
  }
  function status(text) {
    if (!banner) {
      banner = document.createElement('div'); banner.setAttribute('role', 'status');
      banner.style.cssText = 'position:fixed;z-index:9999;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 16px;border-radius:10px;background:#24324f;color:#fff;font:600 13px/1.4 Pretendard,system-ui,sans-serif;box-shadow:0 10px 30px #1a243a40';
      document.body.appendChild(banner);
    }
    banner.textContent = text; banner.hidden = false;
  }
  function done() { if (--active <= 0 && banner) { active = 0; banner.hidden = true; } }

  const charCount = items => items.reduce((n, it) => n + String(it.str || '').replace(/\s/g, '').length, 0);
  const needsOcr = content => charCount(content.items || []) < MIN_CHARS;

  // Splits a recognised line into phrases at wide gaps (table columns), keeping one baseline per line.
  function phrases(line) {
    const words = (line.words || []).filter(w => String(w.text || '').trim());
    if (!words.length) return [];
    const h = Math.max(1, line.bbox.y1 - line.bbox.y0), out = []; let cur = [words[0]];
    for (let i = 1; i < words.length; i++) {
      if (words[i].bbox.x0 - words[i - 1].bbox.x1 > h * 1.2) { out.push(cur); cur = []; }
      cur.push(words[i]);
    }
    out.push(cur); return out;
  }

  async function recognise(page, { lang = 'kor+eng', scale = 2.5 } = {}) {
    const viewport = page.getViewport({ scale }), canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const { data } = await (await worker(lang)).recognize(canvas);
    const items = [];
    for (const line of data.lines || []) {
      const base = line.baseline && line.baseline.has_baseline !== false ? line.baseline : null;
      for (const group of phrases(line)) {
        const x0 = group[0].bbox.x0, x1 = group[group.length - 1].bbox.x1;
        const top = Math.min(...group.map(w => w.bbox.y0));
        const baselineY = base ? base.y0 + (base.y1 - base.y0) * (((x0 + x1) / 2 - base.x0) / Math.max(1, base.x1 - base.x0)) : Math.max(...group.map(w => w.bbox.y1));
        const [px, py] = viewport.convertToPdfPoint(x0, baselineY), [qx, qy] = viewport.convertToPdfPoint(x1, baselineY);
        const size = Math.max(4, (baselineY - top) / scale / .72); // cap height ≈ 0.72 em
        const str = group.map(w => w.text).join(' '), a = Math.atan2(qy - py, qx - px), c = Math.cos(a), s = Math.sin(a);
        // transform follows pdf.js conventions, including page rotation (text direction in PDF space)
        items.push({ str, transform: [size * c, size * s, -size * s, size * c, px, py], width: Math.hypot(qx - px, qy - py), height: size, fontName: 'ocr', confidence: Math.min(...group.map(w => w.confidence)) });
      }
    }
    return { items, styles: { ocr: { ascent: .8, descent: -.2 } }, ocr: true };
  }

  async function pageContent(page, options = {}) {
    const content = await page.getTextContent();
    if (!needsOcr(content) || options.ocr === false) return content;
    active++; status('스캔 문서를 확인했습니다. 글자 인식을 준비하는 중…');
    try { const result = await recognise(page, options); return charCount(result.items) > charCount(content.items) ? result : content; }
    catch (e) { console.warn('OCR failed', e); status(`글자 인식에 실패했습니다. ${e.message || ''}`); await new Promise(r => setTimeout(r, 4000)); return content; }
    finally { done(); }
  }

  window.ToolOcr = { pageContent, recognise, needsOcr, loadTesseract };
})();
