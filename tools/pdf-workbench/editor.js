(() => {
  const $ = id => document.getElementById(id);
  const workspace = $('editorWorkspace'), overlay = $('editOverlay'), panel = document.querySelector('[data-panel="editor"]');
  const SCALE = 1.5, FONT = 'Pretendard, sans-serif', LINE = 1.25;
  const TOOL_HELP = {
    select: '항목을 클릭해 선택 · 드래그로 이동 · 모서리 핸들로 크기 조절 · 방향키 미세 이동(Shift 10pt) · 더블클릭으로 텍스트 수정',
    text: '페이지에서 넣을 위치를 클릭하세요. 추가 후 바로 내용을 입력할 수 있습니다.',
    cover: '가릴 영역을 드래그하세요.',
    highlight: '강조할 영역을 드래그하세요.',
    image: '이미지 파일을 고른 뒤 넣을 영역을 드래그하세요. 비율은 유지됩니다.'
  };
  const LABEL = { text: '텍스트 선택됨', image: '이미지 선택됨', cover: '가리기 선택됨', highlight: '형광펜 선택됨' };
  const NEW_LABEL = { select: '선택한 항목 없음', text: '새 텍스트', cover: '흰색 가리기', highlight: '형광펜', image: '이미지 · 서명 · 도장' };

  let source, preview, pages = [], active = 0, selected = new Set(), undo = [], redo = [];
  let viewport, imageData, renderedKey = '', anchor = null, dragIndex, start = null;
  let busy = false, rendering = false, working = false, dirty = false, editSession = false;
  let selectedObject = -1, gesture = null, messageTimer;
  const imageCache = new Map();
  const locked = () => busy || rendering || working;
  const mode = () => workspace.dataset.mode;
  const tool = () => $('editTool').value;
  const current = () => pages[active];
  const currentItem = () => current()?.items[selectedObject];
  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- history ----------
  const snapshot = () => ({ pages: clone(pages), active, selected: [...selected] });
  function remember() { undo.push(snapshot()); if (undo.length > 60) undo.shift(); redo = []; dirty = true; }
  function restore(from, to) {
    if (!from.length) return;
    to.push(snapshot()); const s = from.pop();
    pages = s.pages; active = Math.min(s.active, pages.length - 1); selected = new Set(s.selected); dirty = true;
    return refresh();
  }
  function action(fn) {
    return async (...args) => {
      if (locked()) return;
      working = true; workspace.setAttribute('aria-busy', 'true');
      try { await fn(...args); } catch (e) { notify(e.message || String(e), true); }
      finally { working = false; workspace.setAttribute('aria-busy', 'false'); count(); }
    };
  }
  function notify(text, isError = false) {
    const box = $('editMessage'); clearTimeout(messageTimer);
    box.textContent = text; box.hidden = false; box.classList.toggle('is-error', isError);
    messageTimer = setTimeout(() => { box.hidden = true; }, isError ? 6000 : 3500);
  }

  // ---------- status / toggles ----------
  function count() {
    const n = selected.size;
    $('editCount').textContent = `${n}페이지 선택됨`;
    $('editBulk').hidden = !n;
    $('editUndo').disabled = !undo.length; $('editRedo').disabled = !redo.length;
    $('editDelete').disabled = n === pages.length;
    $('editDelete').title = n === pages.length ? '최소 한 페이지는 남겨야 합니다' : '선택 페이지 삭제 (Delete)';
    $('editPrev').disabled = active <= 0; $('editNext').disabled = active >= pages.length - 1;
    $('editPageJump').value = String(active);
  }
  function setMode(next) {
    workspace.dataset.mode = next;
    $('editModePages').setAttribute('aria-pressed', String(next === 'pages'));
    $('editModeContent').setAttribute('aria-pressed', String(next === 'content'));
    $('editModeHint').textContent = next === 'pages'
      ? '① 페이지를 정리하고 ② 내용 편집에서 텍스트·서명을 넣은 뒤 ③ PDF 저장을 누르세요.'
      : '도구를 고르고 페이지 위를 클릭하거나 드래그하세요. 추가한 항목은 언제든 다시 선택해 고칠 수 있습니다.';
    $('editPageHelp').textContent = next === 'pages'
      ? '클릭으로 선택 · Shift+클릭 범위 선택 · 드래그로 순서 변경(선택한 페이지는 함께 이동) · 더블클릭하면 내용 편집'
      : '편집할 페이지를 클릭하세요.';
    renderCards();
  }
  $('editModePages').onclick = action(() => setMode('pages'));
  $('editModeContent').onclick = action(async () => {
    if (selected.size && !selected.has(current().id)) active = pages.findIndex(p => selected.has(p.id));
    setMode('content'); await renderPreview();
  });

  // ---------- page list ----------
  function renderCards() {
    $('editPageJump').replaceChildren(...pages.map((p, i) => new Option(`${i + 1} / ${pages.length}`, i)));
    const cards = pages.map((p, i) => {
      const card = document.createElement('div'); card.className = 'page-card'; card.draggable = true; card.dataset.index = i;
      const check = document.createElement('input'); check.type = 'checkbox'; check.setAttribute('aria-label', `${i + 1}페이지 선택`);
      check.onchange = () => { if (locked()) { check.checked = selected.has(p.id); return; } toggleSelect(i, { shiftKey: false }, check.checked); };
      const open = document.createElement('button'); open.type = 'button'; open.className = 'page-open';
      open.setAttribute('aria-label', `${i + 1}페이지 (원본 ${p.original + 1})`);
      const frame = document.createElement('span'); frame.className = 'page-thumb';
      const img = document.createElement('img'); img.src = p.thumb; img.alt = ''; img.draggable = false;
      if (p.rotation) img.style.transform = `rotate(${p.rotation}deg)${p.rotation % 180 ? ' scale(.72)' : ''}`;
      frame.append(img);
      if (p.items.length) { const badge = document.createElement('em'); badge.className = 'page-badge'; badge.textContent = `편집 ${p.items.length}`; frame.append(badge); }
      const label = document.createElement('span'); label.className = 'page-label';
      label.innerHTML = `<b>${i + 1}</b><small>원본 ${p.original + 1}${p.rotation ? ` · ${p.rotation}°` : ''}</small>`;
      open.append(frame, label);
      open.onclick = e => {
        if (locked()) return;
        if (mode() === 'pages') toggleSelect(i, e);
        else action(async () => { active = i; renderCards(); count(); await renderPreview(); })();
      };
      open.ondblclick = action(async () => { active = i; setMode('content'); await renderPreview(); });
      const controls = document.createElement('div'); controls.className = 'page-move';
      for (const [text, delta] of [['←', -1], ['→', 1]]) {
        const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = text; btn.className = 'btn btn--secondary';
        btn.setAttribute('aria-label', `${i + 1}페이지 ${delta < 0 ? '앞으로' : '뒤로'} 이동`);
        btn.disabled = i + delta < 0 || i + delta >= pages.length; btn.onclick = action(() => move(i, i + delta)); controls.append(btn);
      }
      card.ondragstart = e => { if (locked()) return e.preventDefault(); dragIndex = i; card.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); };
      card.ondragover = e => { if (!Number.isInteger(dragIndex)) return; e.preventDefault(); e.stopPropagation(); markDrop(card, e); };
      card.ondragleave = () => card.classList.remove('drop-before', 'drop-after');
      card.ondrop = e => {
        if (!Number.isInteger(dragIndex)) return;
        e.preventDefault(); e.stopPropagation(); const after = dropAfter(card, e), from = dragIndex; clearDrop();
        dragIndex = undefined; action(() => dropPages(from, i, after))();
      };
      card.ondragend = () => { dragIndex = undefined; clearDrop(); };
      card.append(check, open, controls); return card;
    });
    $('editPages').replaceChildren(...cards); updateSelectionUI();
  }
  function updateSelectionUI() {
    for (const card of $('editPages').children) {
      const i = Number(card.dataset.index), p = pages[i]; if (!p) continue;
      const isSel = selected.has(p.id), isActive = i === active;
      card.classList.toggle('is-selected', isSel); card.classList.toggle('active', isActive);
      card.querySelector('input').checked = isSel;
      card.querySelector('.page-open').setAttribute('aria-pressed', String(mode() === 'pages' ? isSel : isActive));
    }
    count();
  }
  function toggleSelect(i, e, force) {
    const id = pages[i].id;
    if (e.shiftKey && anchor !== null && pages[anchor]) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      for (let k = a; k <= b; k++) selected.add(pages[k].id);
    } else {
      const on = force ?? !selected.has(id); on ? selected.add(id) : selected.delete(id); anchor = i;
    }
    updateSelectionUI();
  }
  const dropAfter = (card, e) => { const r = card.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
  function markDrop(card, e) { clearDrop(); card.classList.add(dropAfter(card, e) ? 'drop-after' : 'drop-before'); }
  function clearDrop() { for (const c of $('editPages').children) c.classList.remove('drop-before', 'drop-after', 'is-dragging'); }
  async function dropPages(from, to, after) {
    const dragged = pages[from]; const group = selected.has(dragged.id) && selected.size > 1 ? pages.filter(p => selected.has(p.id)) : [dragged];
    const target = pages[to]; if (group.includes(target) && group.length === 1) return;
    const ids = new Set(group.map(p => p.id)); const rest = pages.filter(p => !ids.has(p.id));
    let at = rest.indexOf(target);
    if (at < 0) { at = rest.findIndex(p => pages.indexOf(p) > to); if (at < 0) at = rest.length; } else if (after) at++;
    const next = [...rest.slice(0, at), ...group, ...rest.slice(at)];
    if (next.every((p, k) => p === pages[k])) return;
    remember(); const id = current().id; pages = next; active = pages.findIndex(p => p.id === id); await refresh();
    notify(`${group.length}페이지를 이동했습니다.`);
  }
  async function move(from, to) {
    if (to < 0 || to >= pages.length || from === to) return;
    remember(); const id = current().id; const [p] = pages.splice(from, 1); pages.splice(to, 0, p);
    active = pages.findIndex(q => q.id === id); await refresh();
  }
  async function reorder(kind) {
    if (kind === 'first' || kind === 'last') requireSelection();
    const id = current().id, picked = pages.filter(p => selected.has(p.id)), rest = pages.filter(p => !selected.has(p.id));
    let next = [...pages];
    if (kind === 'first') next = [...picked, ...rest];
    if (kind === 'last') next = [...rest, ...picked];
    if (kind === 'reverse') next.reverse();
    if (kind === 'original') next.sort((a, b) => a.original - b.original);
    if (next.every((p, k) => p === pages[k])) return notify('이미 그 순서입니다.');
    remember(); pages = next; active = pages.findIndex(p => p.id === id); await refresh();
  }
  for (const [id, kind] of [['editFirst', 'first'], ['editLast', 'last'], ['editReverse', 'reverse'], ['editOriginal', 'original']]) $(id).onclick = action(() => reorder(kind));
  function requireSelection() { if (!selected.size) throw new Error('먼저 페이지를 선택하세요.'); }
  $('editSelect').onclick = action(() => { selected = new Set(parsePageRange($('editRange').value, pages.length).map(n => pages[n - 1].id)); updateSelectionUI(); });
  $('editRange').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('editSelect').click(); } };
  $('editAll').onclick = action(() => { selected = new Set(pages.map(p => p.id)); updateSelectionUI(); });
  $('editNone').onclick = action(() => { selected.clear(); anchor = null; updateSelectionUI(); });
  const deletePages = action(async () => {
    requireSelection(); if (selected.size === pages.length) throw new Error('최소 한 페이지는 남겨 주세요.');
    remember(); const n = selected.size, keep = pages.slice(active).find(p => !selected.has(p.id)) || pages.filter(p => !selected.has(p.id)).pop();
    pages = pages.filter(p => !selected.has(p.id)); active = pages.indexOf(keep); selected.clear(); anchor = null; await refresh();
    notify(`${n}페이지를 삭제했습니다. 실행 취소로 되돌릴 수 있습니다.`);
  });
  $('editDelete').onclick = deletePages;
  $('editRotate').onclick = action(async () => {
    requireSelection(); remember();
    for (const p of pages.filter(q => selected.has(q.id))) {
      const pg = await preview.getPage(p.original + 1); const vp = pg.getViewport({ scale: 1, rotation: (pg.rotate + p.rotation) % 360 });
      for (const item of p.items) { const oldX = item.x; item.x = vp.height - item.y; item.y = oldX; item.angle = ((item.angle || 0) + 90) % 360; }
      p.rotation = (p.rotation + 90) % 360;
    }
    await refresh();
  });

  // ---------- preview ----------
  async function refresh() {
    rendering = true;
    try {
      selectObject(-1); gesture = null;
      renderCards(); await renderPreview(true);
    } finally { rendering = false; count(); }
  }
  async function renderPreview(inRefresh = false) {
    const p = current(); if (!p || mode() !== 'content') return;
    if (!inRefresh) rendering = true;
    try {
      const key = `${p.original}:${p.rotation}`;
      if (key !== renderedKey) {
        const page = await preview.getPage(p.original + 1);
        viewport = page.getViewport({ scale: 1, rotation: (page.rotate + p.rotation) % 360 });
        const renderViewport = page.getViewport({ scale: SCALE, rotation: viewport.rotation });
        const base = $('editBase'), next = document.createElement('canvas');
        next.width = Math.ceil(renderViewport.width); next.height = Math.ceil(renderViewport.height);
        await page.render({ canvasContext: next.getContext('2d'), viewport: renderViewport }).promise;
        base.width = overlay.width = next.width; base.height = overlay.height = next.height;
        base.getContext('2d').drawImage(next, 0, 0); renderedKey = key; applyZoom();
      }
      if (selectedObject >= p.items.length) selectObject(-1);
      await prepareImages(p.items); redraw(); selectionSettings();
    } finally { if (!inRefresh) rendering = false; }
  }
  function applyZoom() {
    const v = $('editZoom').value, stage = $('editStage');
    if (viewport) stage.style.aspectRatio = `${viewport.width}/${viewport.height}`;
    stage.style.width = v === 'fit' && viewport ? `min(100%, calc(72vh * ${(viewport.width / viewport.height).toFixed(4)}))` : `${v === 'fit' ? 100 : v}%`;
  }
  $('editZoom').onchange = applyZoom;
  const goPage = action(async delta => { const next = clamp(active + delta, 0, pages.length - 1); if (next === active) return; active = next; selectObject(-1); updateSelectionUI(); await renderPreview(); });
  $('editPrev').onclick = () => goPage(-1); $('editNext').onclick = () => goPage(1);
  $('editPageJump').onchange = () => goPage(Number($('editPageJump').value) - active);

  // ---------- drawing ----------
  const lines = item => String(item.text).split('\n');
  function draw(ctx, item, scale) {
    ctx.save(); ctx.scale(scale, scale); ctx.translate(item.x, item.y); ctx.rotate((item.angle || 0) * Math.PI / 180);
    if (item.kind === 'text') {
      ctx.font = `${item.size}px ${FONT}`; ctx.textBaseline = 'top'; ctx.fillStyle = item.color;
      lines(item).forEach((line, k) => ctx.fillText(line, 0, k * item.size * LINE));
    } else if (item.kind === 'image') {
      const image = imageCache.get(item.data); if (image) ctx.drawImage(image, 0, 0, item.w, item.h);
    } else {
      ctx.fillStyle = item.kind === 'cover' ? '#ffffff' : item.color;
      ctx.globalAlpha = item.kind === 'highlight' ? 0.3 : 1; ctx.fillRect(0, 0, item.w, item.h);
    }
    ctx.restore();
  }
  async function prepareImages(entries) {
    for (const item of entries) if (item.kind === 'image' && !imageCache.has(item.data)) {
      const img = new Image(); img.src = item.data; await img.decode(); imageCache.set(item.data, img);
    }
  }
  async function paint(canvas, entries, scale) {
    await prepareImages(entries);
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const item of entries) draw(ctx, item, scale);
  }
  function itemSize(item) {
    if (item.kind !== 'text') return { w: item.w, h: item.h };
    const ctx = overlay.getContext('2d'); ctx.font = `${item.size}px ${FONT}`;
    const rows = lines(item);
    return { w: Math.max(...rows.map(r => ctx.measureText(r).width), item.size * .5), h: item.size * LINE * rows.length };
  }
  const pxToPt = () => viewport ? viewport.width / overlay.getBoundingClientRect().width : 1;
  function redraw(draft) {
    const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!current()) return;
    current().items.forEach((item, i) => draw(ctx, gesture && i === selectedObject ? gesture.draft : item, SCALE));
    const item = draft || (gesture ? gesture.draft : currentItem());
    if (!item) return;
    const size = itemSize(item), handle = 7 * pxToPt();
    ctx.save(); ctx.scale(SCALE, SCALE); ctx.translate(item.x, item.y); ctx.rotate((item.angle || 0) * Math.PI / 180);
    ctx.strokeStyle = '#4f6bdc'; ctx.lineWidth = 1.2 * pxToPt(); ctx.setLineDash([4 * pxToPt(), 3 * pxToPt()]); ctx.strokeRect(-2, -2, size.w + 4, size.h + 4);
    if (!draft) { ctx.setLineDash([]); ctx.fillStyle = '#fff'; ctx.fillRect(size.w + 2 - handle / 2, size.h + 2 - handle / 2, handle, handle); ctx.strokeRect(size.w + 2 - handle / 2, size.h + 2 - handle / 2, handle, handle); }
    ctx.restore();
  }

  // ---------- tools & properties ----------
  function setTool(next) {
    $('editTool').value = next; selectObject(-1); gesture = null; start = null;
    for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === next));
    if (next === 'highlight') $('editColor').value = '#ffe047';
    if (next === 'text' && $('editColor').value.toLowerCase() === '#ffe047') $('editColor').value = '#263a68';
    selectionSettings(); redraw();
  }
  for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => { if (!locked()) setTool(b.dataset.tool); };
  function selectObject(i) { if (i !== selectedObject) editSession = false; selectedObject = i; }
  const setValue = (el, v) => { if (el.value !== String(v)) el.value = v; };
  function selectionSettings() {
    const item = currentItem(), kind = item?.kind || tool();
    $('editTextField').hidden = kind !== 'text'; $('editSizeField').hidden = kind !== 'text';
    $('editColorField').hidden = !['text', 'highlight'].includes(kind);
    $('editImageField').hidden = !!item || tool() !== 'image';
    $('editWidthField').hidden = !item || kind === 'text';
    $('editSelection').hidden = !item;
    $('editSelectionLabel').textContent = item ? LABEL[kind] : NEW_LABEL[tool()];
    document.querySelector('.edit-controls').classList.toggle('is-selected', !!item);
    if (item) {
      if (kind === 'text') { setValue($('editText'), item.text); setValue($('editSize'), item.size); }
      if (item.color) setValue($('editColor'), item.color);
      if (kind !== 'text') setValue($('editObjectWidth'), Math.round(item.w));
    }
    $('editHelp').textContent = TOOL_HELP[tool()];
    overlay.style.cursor = tool() === 'select' ? 'default' : 'crosshair';
  }
  function liveEdit() {
    const item = currentItem(); if (!item || locked()) return;
    const next = { ...item };
    if (item.kind === 'text') {
      const size = Number($('editSize').value); if ($('editText').value.trim()) next.text = $('editText').value.replace(/\s+$/, '');
      if (Number.isFinite(size) && size >= 6 && size <= 144) next.size = size;
    } else {
      const w = Number($('editObjectWidth').value);
      if (Number.isFinite(w) && w >= 3 && w <= Math.max(viewport.width, viewport.height)) { next.h = item.h * w / item.w; next.w = w; }
    }
    if (['text', 'highlight'].includes(item.kind)) next.color = $('editColor').value;
    if (JSON.stringify(next) === JSON.stringify(item)) return;
    if (!editSession) { remember(); editSession = true; }
    current().items[selectedObject] = next; redraw(); count();
  }
  for (const id of ['editText', 'editSize', 'editColor', 'editObjectWidth']) $(id).addEventListener('input', liveEdit);
  for (const id of ['editText', 'editSize', 'editObjectWidth']) $(id).addEventListener('change', () => { editSession = false; selectionSettings(); });
  $('editText').addEventListener('input', () => { const t = $('editText'); t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; });
  $('editText').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); editSession = false; overlay.focus({ preventScroll: true }); } };
  function removeObject() {
    if (!currentItem()) return;
    remember(); current().items.splice(selectedObject, 1); selectObject(-1); redraw(); selectionSettings(); renderCards();
  }
  function duplicateObject() {
    const item = currentItem(); if (!item) return;
    remember(); const copy = { ...item, x: Math.min(item.x + 12, viewport.width - 6), y: Math.min(item.y + 12, viewport.height - 6) };
    current().items.push(copy); selectObject(current().items.length - 1); redraw(); selectionSettings(); renderCards();
  }
  $('editRemove').onclick = action(removeObject); $('editDuplicate').onclick = action(duplicateObject);
  $('editImage').onchange = action(async () => {
    imageData = null; const f = $('editImage').files[0]; if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type)) throw new Error('PNG 또는 JPG 이미지를 선택하세요.');
    imageData = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f); });
    notify('이미지를 넣을 영역을 페이지에서 드래그하세요.');
  });

  // ---------- pointer ----------
  function point(e) { const r = overlay.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width * viewport.width, 0, viewport.width), y: clamp((e.clientY - r.top) / r.height * viewport.height, 0, viewport.height) }; }
  function local(item, pos) {
    const angle = -(item.angle || 0) * Math.PI / 180, dx = pos.x - item.x, dy = pos.y - item.y;
    return { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) };
  }
  function hit(item, pos) { const size = itemSize(item), l = local(item, pos), pad = 4 * pxToPt(); return l.x >= -pad && l.x <= size.w + pad && l.y >= -pad && l.y <= size.h + pad; }
  function onHandle(item, pos) { const size = itemSize(item), l = local(item, pos), r = 9 * pxToPt(); return Math.abs(l.x - size.w - 2) <= r && Math.abs(l.y - size.h - 2) <= r; }
  overlay.onpointerdown = e => {
    if (locked() || e.button !== 0 || !viewport) return;
    start = point(e); overlay.focus({ preventScroll: true }); overlay.setPointerCapture(e.pointerId);
    if (tool() !== 'select') return;
    const sel = currentItem();
    if (sel && onHandle(sel, start)) { gesture = { kind: 'resize', original: { ...sel }, draft: { ...sel }, size: itemSize(sel) }; redraw(); return; }
    selectObject(current().items.findLastIndex(item => hit(item, start)));
    const item = currentItem(); gesture = item ? { kind: 'move', original: { ...item }, draft: { ...item } } : null;
    redraw(); selectionSettings();
  };
  overlay.onpointermove = e => {
    if (!viewport) return;
    const pos = point(e);
    if (!start) {
      const sel = tool() === 'select' && currentItem();
      overlay.style.cursor = sel && onHandle(sel, pos) ? 'nwse-resize' : tool() !== 'select' ? 'crosshair' : current()?.items.some(it => hit(it, pos)) ? 'move' : 'default';
      return;
    }
    if (locked()) return;
    if (gesture?.kind === 'move') { gesture.draft.x = gesture.original.x + pos.x - start.x; gesture.draft.y = gesture.original.y + pos.y - start.y; redraw(); }
    else if (gesture?.kind === 'resize') {
      const o = gesture.original, l = local(o, pos), d = gesture.draft;
      if (o.kind === 'text') d.size = Math.round(clamp(o.size * (l.x - 2) / gesture.size.w, 6, 144) * 10) / 10;
      else { d.w = Math.max(3, l.x - 2); d.h = o.kind === 'image' ? d.w * o.h / o.w : Math.max(3, l.y - 2); }
      redraw();
    } else if (['cover', 'highlight', 'image'].includes(tool())) {
      redraw({ kind: 'cover', x: Math.min(start.x, pos.x), y: Math.min(start.y, pos.y), w: Math.abs(start.x - pos.x), h: Math.abs(start.y - pos.y) });
    }
  };
  overlay.onpointercancel = () => { start = null; gesture = null; redraw(); };
  overlay.onpointerup = async e => {
    if (!start || locked()) return;
    const a = start; start = null; const b = point(e), kind = tool();
    if (kind === 'select') {
      if (gesture && JSON.stringify(gesture.draft) !== JSON.stringify(gesture.original)) { remember(); current().items[selectedObject] = { ...gesture.draft }; }
      gesture = null; redraw(); selectionSettings(); count(); return;
    }
    await action(async () => {
      const item = { kind, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y), color: $('editColor').value, angle: 0 };
      let placeholder = false;
      if (kind === 'text') {
        const typed = $('editText').value.replace(/\s+$/, ''); placeholder = !typed.trim();
        item.text = placeholder ? '텍스트' : typed; item.size = clamp(Number($('editSize').value) || 16, 6, 144); item.x = a.x; item.y = a.y;
        delete item.w; delete item.h; await document.fonts.ready;
      } else {
        if (item.w < 3 || item.h < 3) throw new Error('마우스로 드래그해 영역을 지정하세요.');
        if (kind === 'image') {
          if (!imageData) { $('editImage').click(); throw new Error('먼저 넣을 PNG/JPG 이미지를 선택하세요.'); }
          const img = new Image(); img.src = imageData; await img.decode();
          const factor = Math.min(item.w / img.width, item.h / img.height); item.w = img.width * factor; item.h = img.height * factor; item.data = imageData;
          delete item.color;
        }
        if (kind === 'cover') delete item.color;
      }
      await prepareImages([item]); remember(); current().items.push(item);
      $('editTool').value = 'select'; for (const btn of document.querySelectorAll('[data-tool]')) btn.setAttribute('aria-pressed', String(btn.dataset.tool === 'select'));
      selectObject(current().items.length - 1); editSession = false; redraw(); selectionSettings(); renderCards();
      if (placeholder) { $('editText').focus(); $('editText').select(); }
    })();
    if (selectedObject < 0) redraw();
  };
  overlay.ondblclick = e => {
    if (tool() !== 'select' || !viewport) return;
    const item = currentItem(); if (item?.kind === 'text' && hit(item, point(e))) { $('editText').focus(); $('editText').select(); }
  };

  // ---------- keyboard ----------
  document.addEventListener('keydown', event => {
    if (!panel.classList.contains('is-active') || !pages.length || locked()) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName), mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (typing) return;
    if (mod && (key === 'z' || key === 'y')) { event.preventDefault(); const redoKey = key === 'y' || event.shiftKey; action(() => redoKey ? restore(redo, undo) : restore(undo, redo))(); return; }
    if (mode() === 'pages') {
      if (mod && key === 'a') { event.preventDefault(); selected = new Set(pages.map(p => p.id)); updateSelectionUI(); }
      else if (key === 'escape') { selected.clear(); anchor = null; updateSelectionUI(); }
      else if ((key === 'delete' || key === 'backspace') && selected.size) { event.preventDefault(); deletePages(); }
      return;
    }
    if (event.key === 'PageUp') { event.preventDefault(); goPage(-1); return; }
    if (event.key === 'PageDown') { event.preventDefault(); goPage(1); return; }
    const item = currentItem();
    if (mod && key === 'd' && item) { event.preventDefault(); action(duplicateObject)(); return; }
    if (mod || event.altKey) return;
    const shortcuts = { v: 'select', t: 'text', e: 'cover', h: 'highlight', i: 'image' };
    if (shortcuts[key]) { event.preventDefault(); setTool(shortcuts[key]); return; }
    if (key === 'escape') { selectObject(-1); setTool('select'); return; }
    if ((key === 'delete' || key === 'backspace') && item) { event.preventDefault(); action(removeObject)(); return; }
    if (key === 'enter' && item?.kind === 'text') { event.preventDefault(); $('editText').focus(); $('editText').select(); return; }
    const offsets = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (item && offsets[key]) {
      event.preventDefault(); if (!editSession) { remember(); editSession = true; }
      const step = event.shiftKey ? 10 : 1; item.x += offsets[key][0] * step; item.y += offsets[key][1] * step; redraw(); count();
    }
  });
  document.addEventListener('keyup', event => { if (event.key.startsWith('Arrow')) editSession = false; });

  // ---------- open ----------
  function openFiles(files) {
    if (!files.length || locked()) return;
    if (dirty && !confirm('저장하지 않은 편집 내용이 있습니다. 새 PDF를 열면 사라집니다. 계속할까요?')) return;
    return action(async () => {
      if (files.length !== 1) throw new Error('편집할 PDF 한 개만 놓아 주세요. 여러 파일은 PDF 합치기 탭에서 합칠 수 있습니다.');
      const file = files[0];
      if (!isPdf(file)) throw new Error('PDF 파일을 선택하거나 끌어다 놓아 주세요.');
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
          const vp = page.getViewport({ scale: 180 / Math.max(view.width, view.height) }); const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          nextPages.push({ id: i, original: i, rotation: 0, items: [], thumb: canvas.toDataURL('image/jpeg', .7) });
          $('editorStatus').textContent = `미리보기 준비 중 · ${i + 1}/${nextPreview.numPages}`;
        }
        if (preview) await preview.destroy();
        source = nextSource; preview = nextPreview; pages = nextPages; renderedKey = ''; viewport = null;
        active = 0; selected.clear(); anchor = null; undo = []; redo = []; imageData = null; dirty = false; imageCache.clear();
        $('editImage').value = ''; $('editZoom').value = 'fit'; workspace.hidden = false; $('editorDrop').classList.add('has-document');
        $('editName').value = `${baseName(file.name)}_edited.pdf`;
        setMode('pages'); setTool('select'); await refresh();
        $('editorStatus').textContent = `${file.name} · ${pages.length}페이지 · 원본 파일은 변경되지 않습니다.`;
      } catch (e) { if (nextPreview && nextPreview !== preview) await nextPreview.destroy(); throw new Error(`PDF를 열지 못했습니다. 암호가 있으면 잠금 해제 후 열어 주세요. ${e.message}`); }
      finally { busy = false; }
    })();
  }
  $('editorInput').onchange = () => { const files = Array.from($('editorInput').files); $('editorInput').value = ''; openFiles(files); };
  const drop = $('editorDrop');
  drop.onclick = () => { if (!locked()) $('editorInput').click(); };
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.click(); } };
  const isFileDrag = e => Array.from(e.dataTransfer?.types || []).includes('Files');
  for (const name of ['dragenter', 'dragover']) panel.addEventListener(name, e => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = locked() ? 'none' : 'copy';
    if (!locked()) drop.classList.add('is-hover');
  });
  panel.addEventListener('dragleave', e => { if (!panel.contains(e.relatedTarget)) drop.classList.remove('is-hover'); });
  panel.addEventListener('drop', e => { if (!isFileDrag(e)) return; e.preventDefault(); drop.classList.remove('is-hover'); openFiles(Array.from(e.dataTransfer.files)); });
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  $('editUndo').onclick = action(() => restore(undo, redo)); $('editRedo').onclick = action(() => restore(redo, undo));

  // ---------- save ----------
  async function save(onlySelected, separate = false) {
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
      const name = baseName($('editName').value) || 'edited';
      if (separate) {
        const zip = new JSZip();
        for (let i = 0; i < output.getPageCount(); i++) {
          const part = await PDFLib.PDFDocument.create(); const [page] = await part.copyPages(output, [i]); part.addPage(page);
          const position = pages.findIndex(p => p.id === chosen[i].id) + 1;
          zip.file(`${name}_p${String(position).padStart(3, '0')}.pdf`, await part.save());
        }
        downloadBlob(await zip.generateAsync({ type: 'blob' }), `${name}_pages.zip`);
      } else {
        downloadBlob(new Blob([await output.save()], { type: 'application/pdf' }), normalizePdfName(onlySelected ? `${name}_extracted.pdf` : $('editName').value || 'edited.pdf'));
        if (!onlySelected) dirty = false;
      }
      notify(`${chosen.length}페이지 ${separate ? 'ZIP' : onlySelected ? '추출본' : '편집본'} 저장 완료. 원본 파일은 변경되지 않습니다.`);
    } finally { busy = false; }
  }
  $('editZip').onclick = action(() => save(true, true));
  $('editSave').onclick = action(() => save(false)); $('editExtract').onclick = action(() => save(true));
  $('editName').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('editSave').click(); } };
  setMode('pages'); selectionSettings();
})();
