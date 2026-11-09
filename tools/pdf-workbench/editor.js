(() => {
  const $ = id => document.getElementById(id);
  let source, preview, pages = [], active = 0, selected = new Set(), undo = [], redo = [];
  let viewport, imageData, rendering = false, dragIndex, start, busy = false, working = false;
  const clone = value => JSON.parse(JSON.stringify(value));
  const current = () => pages[active];
  const snapshot = () => ({ pages: clone(pages), active, selected: [...selected] });
  function remember() { undo.push(snapshot()); if (undo.length > 40) undo.shift(); redo = []; }
  function restore(from, to) {
    if (!from.length) return;
    to.push(snapshot()); const s = from.pop(); pages = s.pages; active = s.active; selected = new Set(s.selected); return refresh();
  }
  function action(fn) { return async () => { if (busy || rendering || working) return; working = true; $('editorWorkspace').setAttribute('aria-busy', 'true'); try { await fn(); } catch (e) { $('editorStatus').textContent = e.message || String(e); } finally { working = false; $('editorWorkspace').setAttribute('aria-busy', 'false'); } }; }
  function count() { $('editCount').textContent = `${pages.length}페이지 · ${selected.size}페이지 선택`; }
  function draw(ctx, item, scale) {
    ctx.save(); ctx.scale(scale, scale);
    if (item.kind === 'text') {
      ctx.font = `${item.size}px Pretendard, sans-serif`; ctx.textBaseline = 'top'; ctx.fillStyle = item.color;
      ctx.fillText(item.text, item.x, item.y);
    } else if (item.kind === 'image') {
      ctx.drawImage(item.image, item.x, item.y, item.w, item.h);
    } else {
      ctx.fillStyle = item.kind === 'cover' ? '#ffffff' : item.color;
      ctx.globalAlpha = item.kind === 'highlight' ? 0.3 : 1;
      ctx.fillRect(item.x, item.y, item.w, item.h);
    }
    ctx.restore();
  }
  async function paint(canvas, entries, scale) {
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const entry of entries) {
      const item = { ...entry };
      if (item.kind === 'image') { item.image = new Image(); item.image.src = item.data; await item.image.decode(); }
      draw(ctx, item, scale);
    }
  }
  async function refresh() {
    rendering = true;
    try {
      $('editPages').replaceChildren(); count();
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i]; const card = document.createElement('div');
        card.className = `page-card${i === active ? ' active' : ''}`; card.draggable = true;
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(p.id); check.setAttribute('aria-label', `${i + 1}페이지 선택`);
        check.onchange = () => { if (busy) { check.checked = selected.has(p.id); return; } check.checked ? selected.add(p.id) : selected.delete(p.id); count(); };
        const open = document.createElement('button'); open.className = 'page-open'; open.setAttribute('aria-label', `${i + 1}페이지 편집`);
        const img = document.createElement('img'); img.src = p.thumb; img.alt = ''; img.style.transform = `rotate(${p.rotation}deg)`;
        const label = document.createElement('span'); label.textContent = `${i + 1} · 원본 ${p.original + 1}`;
        open.append(img, label); open.onclick = action(async () => { active = i; await refresh(); });
        const controls = document.createElement('div'); controls.className = 'page-move';
        for (const [text, delta] of [['←', -1], ['→', 1]]) {
          const btn = document.createElement('button'); btn.textContent = text; btn.className = 'btn btn--secondary'; btn.setAttribute('aria-label', `${i + 1}페이지 ${delta < 0 ? '앞으로' : '뒤로'} 이동`);
          btn.onclick = action(() => move(i, i + delta)); controls.append(btn);
        }
        card.ondragstart = e => { if (busy || rendering) return e.preventDefault(); dragIndex = i; e.dataTransfer.setData('text/plain', String(i)); };
        card.ondragover = e => e.preventDefault();
        card.ondrop = e => { e.preventDefault(); if (!busy && !rendering && !working && Number.isInteger(dragIndex)) action(() => move(dragIndex, i))(); dragIndex = undefined; };
        card.ondragend = () => { dragIndex = undefined; };
        card.append(check, open, controls); $('editPages').append(card);
      }
      const p = current(); const page = await preview.getPage(p.original + 1);
      viewport = page.getViewport({ scale: 1, rotation: (page.rotate + p.rotation) % 360 });
      const renderViewport = page.getViewport({ scale: 1.5, rotation: viewport.rotation });
      const base = $('editBase'), overlay = $('editOverlay');
      base.width = overlay.width = Math.ceil(renderViewport.width); base.height = overlay.height = Math.ceil(renderViewport.height);
      $('editStage').style.aspectRatio = `${viewport.width}/${viewport.height}`;
      await page.render({ canvasContext: base.getContext('2d'), viewport: renderViewport }).promise;
      await paint(overlay, p.items, 1.5);
    } finally { rendering = false; }
  }
  async function move(from, to) {
    if (to < 0 || to >= pages.length || from === to) return;
    remember(); const id = current().id; const [p] = pages.splice(from, 1); pages.splice(to, 0, p); active = pages.findIndex(p => p.id === id); await refresh();
  }
  $('editorInput').onchange = action(async () => {
    const file = $('editorInput').files[0]; $('editorInput').value = ''; if (!file) return;
    busy = true; $('editorStatus').textContent = 'PDF와 페이지 미리보기를 불러오는 중…';
    let nextPreview;
    try {
      requireLibraries();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const nextSource = await PDFLib.PDFDocument.load(bytes);
      nextPreview = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const nextPages = [];
      for (let i = 0; i < nextPreview.numPages; i++) {
        const page = await nextPreview.getPage(i + 1); const view = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 130 / view.width }); const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        nextPages.push({ id: i, original: i, rotation: 0, items: [], thumb: canvas.toDataURL('image/jpeg', .65) });
        $('editorStatus').textContent = `미리보기 준비 중 · ${i + 1}/${nextPreview.numPages}`;
      }
      if (preview) await preview.destroy(); source = nextSource; preview = nextPreview; pages = nextPages;
      active = 0; selected.clear(); undo = []; redo = []; imageData = null;
      $('editorWorkspace').hidden = false; $('editName').value = `${baseName(file.name)}_edited.pdf`;
      await refresh(); $('editorStatus').textContent = `${file.name} · ${pages.length}페이지 · 변경한 내용은 저장 버튼을 눌러 다운로드하세요.`;
    } catch (e) { if (nextPreview && nextPreview !== preview) await nextPreview.destroy(); throw new Error(`PDF를 열지 못했습니다. 암호가 있으면 잠금 해제 후 열어 주세요. ${e.message}`); }
    finally { busy = false; }
  });
  $('editUndo').onclick = action(() => restore(undo, redo)); $('editRedo').onclick = action(() => restore(redo, undo));
  $('editSelect').onclick = action(() => { selected = new Set(parsePageRange($('editRange').value, pages.length).map(n => pages[n - 1].id)); return refresh(); });
  $('editAll').onclick = action(() => { selected = new Set(pages.map(p => p.id)); return refresh(); });
  $('editNone').onclick = action(() => { selected.clear(); return refresh(); });
  function requireSelection() { if (!selected.size) throw new Error('먼저 페이지를 체크하세요.'); }
  $('editDelete').onclick = action(async () => {
    requireSelection(); if (selected.size === pages.length) throw new Error('최소 한 페이지는 남겨 주세요.');
    remember(); const id = current().id; pages = pages.filter(p => !selected.has(p.id)); active = Math.max(0, pages.findIndex(p => p.id === id)); selected.clear(); await refresh();
  });
  $('editRotate').onclick = action(async () => {
    requireSelection(); remember();
    for (const p of pages.filter(p => selected.has(p.id))) {
      // Rotate added artwork together with the page by baking just the transparent overlay.
      if (p.items.length) {
        const pg = await preview.getPage(p.original + 1); const vp = pg.getViewport({ scale: 1, rotation: (pg.rotate + p.rotation) % 360 });
        const c = document.createElement('canvas'); c.width = Math.ceil(vp.width * 2); c.height = Math.ceil(vp.height * 2); await paint(c, p.items, 2);
        const rotated = document.createElement('canvas'); rotated.width = c.height; rotated.height = c.width;
        const ctx = rotated.getContext('2d'); ctx.translate(rotated.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(c, 0, 0);
        p.items = [{ kind: 'image', data: rotated.toDataURL(), x: 0, y: 0, w: vp.height, h: vp.width }];
      }
      p.rotation = (p.rotation + 90) % 360;
    }
    await refresh();
  });
  $('editTool').onchange = () => {
    const tool = $('editTool').value;
    $('editTextField').hidden = tool !== 'text'; $('editImageField').hidden = tool !== 'image';
    $('editHelp').textContent = tool === 'text' ? '텍스트를 입력한 뒤 원하는 위치를 클릭하세요.' : tool === 'image' ? 'PNG/JPG를 선택하고 페이지에서 드래그해 크기와 위치를 지정하세요. 이미지 비율은 유지됩니다.' : '페이지에서 드래그해 영역을 지정하세요. 잘못 추가한 내용은 실행 취소로 되돌릴 수 있습니다.';
    if (tool === 'highlight') $('editColor').value = '#ffe047';
  }; $('editTool').onchange();
  $('editImage').onchange = action(async () => {
    imageData = null; const f = $('editImage').files[0]; if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type)) throw new Error('PNG 또는 JPG 이미지를 선택하세요.');
    imageData = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f); });
  });
  function point(e) { const r = $('editOverlay').getBoundingClientRect(); return { x: Math.max(0, Math.min(viewport.width, (e.clientX - r.left) / r.width * viewport.width)), y: Math.max(0, Math.min(viewport.height, (e.clientY - r.top) / r.height * viewport.height)) }; }
  $('editOverlay').onpointerdown = e => { if (busy || rendering || e.button !== 0) return; start = point(e); $('editOverlay').setPointerCapture(e.pointerId); };
  $('editOverlay').onpointercancel = () => { start = null; };
  $('editOverlay').onpointerup = async e => {
    if (!start || busy || rendering) return;
    const a = start; start = null; const b = point(e); const kind = $('editTool').value;
    await action(async () => {
      const item = { kind, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y), color: $('editColor').value };
      if (kind === 'text') {
        item.text = $('editText').value.trim(); item.size = Number($('editSize').value); item.x = a.x; item.y = a.y;
        if (!item.text) throw new Error('추가할 텍스트를 입력하세요.');
        if (!Number.isFinite(item.size) || item.size < 6 || item.size > 144) throw new Error('글자 크기는 6~144pt로 입력하세요.');
        await document.fonts.ready;
      } else {
        if (item.w < 3 || item.h < 3) throw new Error('마우스로 드래그해 영역을 지정하세요.');
        if (kind === 'image') {
          if (!imageData) throw new Error('먼저 PNG/JPG 이미지를 선택하세요.');
          const img = new Image(); img.src = imageData; await img.decode();
          const factor = Math.min(item.w / img.width, item.h / img.height); item.w = img.width * factor; item.h = img.height * factor; item.data = imageData;
        }
      }
      remember(); current().items.push(item); await paint($('editOverlay'), current().items, 1.5);
    })();
  };
  async function save(onlySelected) {
    if (onlySelected) requireSelection();
    busy = true; $('editorStatus').textContent = 'PDF를 저장하는 중…';
    try {
      await document.fonts.ready;
      const output = await PDFLib.PDFDocument.create(); const chosen = pages.filter(p => !onlySelected || selected.has(p.id));
      for (const p of chosen) {
        const [page] = await output.copyPages(source, [p.original]); const rotation = (page.getRotation().angle + p.rotation) % 360; page.setRotation(PDFLib.degrees(rotation)); output.addPage(page);
        if (p.items.length) {
          const pg = await preview.getPage(p.original + 1); const vp = pg.getViewport({ scale: 1, rotation });
          const canvas = document.createElement('canvas'); canvas.width = Math.ceil(vp.width * 2); canvas.height = Math.ceil(vp.height * 2); await paint(canvas, p.items, 2);
          const img = await output.embedPng(canvas.toDataURL()); const [x, y] = vp.convertToPdfPoint(0, vp.height);
          page.drawImage(img, { x, y, width: vp.width, height: vp.height, rotate: PDFLib.degrees(rotation) });
        }
      }
      downloadBlob(new Blob([await output.save()], { type: 'application/pdf' }), normalizePdfName(onlySelected ? `${baseName($('editName').value)}_extracted.pdf` : $('editName').value));
      $('editorStatus').textContent = `${chosen.length}페이지 ${onlySelected ? '추출' : '편집본'} 저장 완료. 원본 파일은 변경되지 않습니다.`;
    } finally { busy = false; }
  }
  $('editSave').onclick = action(() => save(false)); $('editExtract').onclick = action(() => save(true));
})();
