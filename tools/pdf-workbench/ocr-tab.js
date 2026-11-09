// OCR tab: adds an invisible, searchable text layer to scanned PDFs (appearance is unchanged).
(() => {
  setupDrop('ocr', 'ocrInput', true);
  let fontBytes = null;
  async function loadFont() {
    if (!fontBytes) {
      const res = await fetch(new URL('vendor/fonts/Pretendard-Regular.ttf', location.href));
      if (!res.ok) throw new Error('글꼴을 불러오지 못했습니다.');
      fontBytes = await res.arrayBuffer();
    }
    return fontBytes;
  }

  async function ocrPdf(file, lang, force, progress) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const found = [];
    let recognised = 0, skipped = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      progress(i - 1, doc.numPages, `${i}/${doc.numPages}페이지 글자 인식 중`);
      const page = await doc.getPage(i);
      if (!force && !ToolOcr.needsOcr(await page.getTextContent())) { skipped++; continue; }
      const result = await ToolOcr.recognise(page, { lang });
      found.push({ index: i - 1, items: result.items }); recognised++;
    }
    doc.destroy();
    const chars = found.flatMap(p => p.items.map(it => it.str)).join('');
    if (chars.trim()) {
      if (!window.fontkit || !window.subsetTrueType) throw new Error('글꼴 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.');
      const fontData = await loadFont(), parsed = fontkit.create(new Uint8Array(fontData));
      out.registerFontkit(fontkit);
      const ids = [...new Set(chars)].map(ch => parsed.glyphForCodePoint(ch.codePointAt(0)).id);
      const font = await out.embedFont(subsetTrueType(fontData, ids), { subset: false });
      for (const { index, items } of found) {
        const page = out.getPage(index);
        for (const it of items) {
          const size = Math.hypot(it.transform[0], it.transform[1]), angle = Math.atan2(it.transform[1], it.transform[0]) * 180 / Math.PI;
          const natural = font.widthOfTextAtSize(it.str, size);
          // scale the invisible text so a selection covers the printed words
          const fitted = natural > 0 ? Math.max(size * .4, Math.min(size * 2.5, size * it.width / natural)) : size;
          page.drawText(it.str, { x: it.transform[4], y: it.transform[5], size: fitted, font, opacity: 0, rotate: PDFLib.degrees(angle) });
        }
      }
    }
    return { bytes: await out.save({ useObjectStreams: true }), recognised, skipped, words: found.reduce((n, p) => n + p.items.length, 0) };
  }

  document.getElementById('ocrRun').addEventListener('click', () => handle(async () => {
    requireLibraries();
    if (!window.ToolOcr) throwUserError('OCR 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.');
    const files = [...state.ocr];
    if (!files.length) throwUserError('글자를 인식할 PDF를 선택하세요.');
    const lang = document.getElementById('ocrLang').value, force = document.getElementById('ocrForce').checked;
    await withBusy('글자 인식 엔진을 준비하는 중...', async update => {
      const outputs = []; let recognised = 0, skipped = 0;
      for (let f = 0; f < files.length; f++) {
        const result = await ocrPdf(files[f], lang, force, (done, total, label) => update(((f + done / total) / files.length) * 100, `${files[f].name} · ${label}`));
        recognised += result.recognised; skipped += result.skipped;
        outputs.push(window.workbench.pdfFile(result.bytes, `${baseName(files[f].name)}_ocr.pdf`));
      }
      if (outputs.length === 1) downloadBlob(outputs[0], outputs[0].name);
      else { const zip = new JSZip(); outputs.forEach(o => zip.file(o.name, o)); downloadBlob(await zip.generateAsync({ type: 'blob' }), `ocr_pdfs_${Date.now()}.zip`); }
      update(100, '완료');
      showResult('글자 인식 완료', `${outputs.length}개 파일 · ${recognised}페이지 인식${skipped ? ` · 이미 글자가 있는 ${skipped}페이지는 그대로 둠` : ''}. 이제 PDF 뷰어에서 검색하거나 복사할 수 있습니다.`);
      window.workbench.offerNext(outputs, 'ocr');
    });
  }));
})();
