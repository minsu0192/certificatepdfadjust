'use strict';
(() => {
  const scripts = new Map();
  function script(url) {
    if (!scripts.has(url)) scripts.set(url, new Promise((resolve, reject) => {
      const el = document.createElement('script'); el.src = url;
      el.onload = resolve; el.onerror = () => { scripts.delete(url); el.remove(); reject(Error('PDF 모듈을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해주세요.')); };
      document.head.append(el);
    }));
    return scripts.get(url);
  }
  async function reader() {
    await script('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  async function busy(button, work) {
    const controls = [...document.querySelectorAll('input,textarea,select,button')];
    const disabled = controls.map(el => el.disabled);
    controls.forEach(el => { el.disabled = true; });
    button.setAttribute('aria-busy', 'true');
    try { await work(); }
    finally {
      controls.forEach((el, i) => { el.disabled = disabled[i]; });
      ['excel', 'word', 'pdf'].forEach(id => { $(id).disabled = !rows; });
      button.removeAttribute('aria-busy');
    }
  }

  $('importPdf').onclick = () => busy($('importPdf'), async () => {
    const info = $('importStatus'); info.className = 'hint';
    let task, doc;
    try {
      const file = $('pdfFile').files[0];
      if (!file) throw Error('PDF 파일을 선택해주세요.');
      if (file.size > 30 * 1024 * 1024) throw Error('30MB 이하의 PDF를 선택해주세요.');
      info.textContent = 'PDF를 여는 중…';
      await reader();
      task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password: $('pdfPassword').value });
      doc = await task.promise;
      if (doc.numPages > 100) throw Error('100페이지 이하로 나누어 넣어주세요.');
      const pages = []; let textLines = 0; let ocrPages = 0; const empty = [];
      for (let n = 1; n <= doc.numPages; n++) {
        info.textContent = `${n}/${doc.numPages}페이지 추출 중…`;
        const page = await doc.getPage(n);
        let content = await page.getTextContent();
        if (ToolOcr.needsOcr(content) && $('pdfOcr').value !== 'off') {
          info.textContent = `${n}/${doc.numPages}페이지 글자 인식 중…`;
          const recognised = await ToolOcr.recognise(page, { lang: $('pdfOcr').value });
          if (recognised.items.map(it => it.str).join('').length > content.items.map(it => it.str).join('').length) content = recognised;
          ocrPages++;
        }
        const viewport = page.getViewport({ scale: 1 });
        const items = content.items.filter(it => it.str && it.str.trim()).map(it => {
          const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
          return { text: it.str, x: t[4], y: t[5], end: t[4] + it.width, height: Math.max(4, Math.hypot(t[2], t[3])) };
        });
        if (!items.length) empty.push(n);
        textLines += items.length;
        if (textLines > 200000) throw Error('추출 결과가 너무 큽니다. PDF를 나누어 넣어주세요.');
        const rules = $('pdfMode').value === 'table' ? await PDFTableLayout.readRules(page, viewport, pdfjsLib) : [];
        pages.push({ items, rules, width: viewport.width });
        page.cleanup();
      }
      const extracted = PDFTableLayout.extract(pages, $('pdfMode').value);
      if (extracted.length > 10000) throw Error('추출 결과가 10,000행을 초과했습니다. PDF를 나누어 넣어주세요.');
      if (!extracted.length) throw Error('추출할 글자가 없습니다. 스캔 PDF는 글자 인식을 켜고 다시 시도해주세요.');
      const width = Math.max(...extracted.map(r => r.length));
      if (width > 100) throw Error('추정된 열이 100개를 넘습니다. 텍스트 줄 단위로 다시 추출해주세요.');
      const source = extracted.map(r => Array.from({length:width}, (_,i) => '"' + (r[i] || '').replace(/"/g, '""') + '"').join(',')).join('\n');
      if (source.length > 5000000) throw Error('추출 결과가 너무 큽니다. PDF를 나누어 넣어주세요.');
      $('source').value = source; $('format').value = 'csv';
      $('title').value = file.name.replace(/\.pdf$/i, '');
      $('header').checked = false;
      preview();
      info.textContent = `${doc.numPages}페이지 추출 완료${ocrPages ? ` · ${ocrPages}페이지 OCR` : ''}${empty.length ? ` · 글자 없는 페이지: ${empty.join(', ')}` : ''}. 열 위치·숫자·반복 머리글을 확인하고, 필요하면 입력란을 수정해주세요. 제목 행은 직접 선택해주세요.`;
    } catch (e) {
      info.textContent = e.name === 'PasswordException' ? 'PDF 비밀번호가 필요하거나 올바르지 않습니다. 비밀번호를 입력하고 다시 시도해주세요.' : (e.message || 'PDF를 읽지 못했습니다.');
      info.className = 'hint error';
    } finally { if (doc) await doc.destroy(); else if (task) await task.destroy(); }
  });

  function wrap(text, font, size, width) {
    const result = [];
    for (const paragraph of String(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
      let line = '', used = 0;
      for (const ch of paragraph) {
        const w = font.widthOfTextAtSize(ch, size);
        if (line && used + w > width) { result.push(line); line = ''; used = 0; }
        line += ch; used += w;
      }
      result.push(line);
    }
    return result;
  }
  $('pdf').onclick = () => busy($('pdf'), async () => {
    if (!rows) return;
    try {
      $('status').className = ''; $('status').textContent = 'PDF를 만드는 중…';
      const data = converted().map(row => row.map(v => typeof v === 'number' ? v.toLocaleString('en-US', {maximumFractionDigits:15}) : v));
      await Promise.all([
        script('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js'),
        script('/tools/pdf-workbench/vendor/fontkit/fontkit.umd.min.js'),
        script('/tools/pdf-workbench/ttf-subset.js')
      ]);
      const response = await fetch('/tools/pdf-workbench/vendor/fonts/Pretendard-Regular.ttf');
      if (!response.ok) throw Error('PDF용 글꼴을 불러오지 못했습니다.');
      const fontBytes = await response.arrayBuffer(), parsed = fontkit.create(new Uint8Array(fontBytes));
      const chars = new Set(title() + '0123456789 /열–' + data.flat().join(''));
      const ids = [...chars].map(ch => parsed.glyphForCodePoint(ch.codePointAt(0)).id);
      const doc = await PDFLib.PDFDocument.create(); doc.registerFontkit(fontkit);
      const font = await doc.embedFont(subsetTrueType(fontBytes, ids), {subset:false});
      const mode = $('orientation').value, landscape = mode === 'landscape' || mode === 'auto' && data[0].length > 6;
      const W = landscape ? 841.89 : 595.28, H = landscape ? 595.28 : 841.89;
      const margin = 32, size = 9, lineHeight = 13, padding = 5;
      const ink = PDFLib.rgb(.14,.20,.30), border = PDFLib.rgb(.80,.84,.89);
      let page, y;
      // Wide tables are split into readable column bands instead of shrinking to tiny type.
      const bandSize = landscape ? 8 : 6;
      for (let start = 0; start < data[0].length; start += bandSize) {
        const end = Math.min(start + bandSize, data[0].length), count = end - start, cellWidth = (W - margin * 2) / count;
        const cellLines = row => row.slice(start,end).map(v => wrap(v,font,size,cellWidth-padding*2));
        const header = $('header').checked ? cellLines(data[0]) : null;
        const drawPart = (cells, offset, length, isHeader) => {
          const height = length * lineHeight + padding * 2;
          cells.forEach((lines,c) => {
            const x = margin + c * cellWidth;
            page.drawRectangle({x,y:y-height,width:cellWidth,height,borderColor:border,borderWidth:.5,...(isHeader?{color:PDFLib.rgb(.91,.94,.97)}:{})});
            lines.slice(offset,offset+length).forEach((line,i) => page.drawText(line,{x:x+padding,y:y-padding-size-i*lineHeight,size,font,color:ink}));
          });
          y -= height;
        };
        const newPage = (repeatHeader) => {
          if (doc.getPageCount() >= 1000) throw Error('PDF가 1,000페이지를 초과합니다. 데이터를 나누어 저장해주세요.');
          page = doc.addPage([W,H]); y = H-margin;
          const heading = wrap(title(),font,13,W-margin*2);
          heading.forEach(line => { page.drawText(line,{x:margin,y:y-13,size:13,font,color:ink}); y-=17; });
          y-=10;
          if (data[0].length > bandSize) { page.drawText(`${start+1}–${end} / ${data[0].length}열`,{x:margin,y:y-9,size,font,color:ink}); y-=20; }
          // Very tall headers are rendered in full as ordinary rows, without repeating.
          if (repeatHeader && header && Math.max(...header.map(c=>c.length)) <= 6) drawPart(header,0,Math.max(...header.map(c=>c.length)),true);
        };
        newPage(false);
        for (let r = 0; r < data.length; r++) {
          const cells = cellLines(data[r]), total = Math.max(...cells.map(c=>c.length));
          let offset = 0;
          while (offset < total) {
            let available = Math.floor((y-margin-padding*2)/lineHeight);
            if (available < 1) { newPage(r > 0); available = Math.floor((y-margin-padding*2)/lineHeight); }
            const length = Math.min(total-offset,available);
            drawPart(cells,offset,length,r===0&&$('header').checked); offset+=length;
            if (offset < total) newPage(r > 0);
          }
        }
      }
      doc.getPages().forEach((p,i) => p.drawText(`${i+1} / ${doc.getPageCount()}`,{x:margin,y:15,size:8,font,color:ink}));
      save(new Blob([await doc.save()],{type:'application/pdf'}),filename()+'.pdf');
      $('status').textContent = 'PDF 다운로드가 완료되었습니다. 열이 많은 표는 여러 열 묶음으로 나누어 저장합니다.';
    } catch (e) { error(e); }
  });
})();
