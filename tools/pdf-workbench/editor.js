(() => {
  const $ = id => document.getElementById(id);
  const workspace = $('editorWorkspace'), overlay = $('editOverlay'), panel = document.querySelector('[data-panel="editor"]');
  const SCALE = 1.5, FONT = '"PretendardEdit", Pretendard, sans-serif', LINE = 1.25, MIN_SIZE = 4, MAX_SIZE = 144;
  const TOOL_HELP = {
    select: '항목을 클릭해 선택 · 드래그로 이동 · 모서리 핸들로 크기 조절 · 방향키 미세 이동(Shift 10pt) · 더블클릭으로 텍스트 수정',
    retext: 'PDF에 원래 있던 글자를 클릭하세요. 자동으로 가리고 같은 위치·크기로 고칠 수 있게 열어 줍니다.',
    text: '페이지에서 넣을 위치를 클릭하세요. 추가 후 바로 내용을 입력할 수 있습니다.',
    cover: '가릴 영역을 드래그하세요. 민감한 정보는 \'영구 삭제\'를 켜야 원래 글자까지 지워집니다.',
    highlight: '강조할 영역을 드래그하세요.',
    crop: '남길 영역을 드래그하세요. 바깥 부분은 저장할 때 잘려 나갑니다. 다시 드래그하면 바뀝니다.',
    image: '서명·도장을 고르거나 새로 그린 뒤 페이지를 클릭(기본 크기)하거나 드래그(원하는 크기)하세요.'
  };
  const LABEL = { text: '텍스트 선택됨', image: '이미지 선택됨', cover: '가리기 선택됨', highlight: '형광펜 선택됨' };
  const NEW_LABEL = { select: '선택한 항목 없음', retext: '원문 수정', text: '새 텍스트', cover: '흰색 가리기', highlight: '형광펜', image: '이미지 · 서명 · 도장', crop: '페이지 자르기' };

  let sources = [], pages = [], active = 0, selected = new Set(), undo = [], redo = [];
  let nextId = 0, docGen = 0, thumbRun = null, autosaveTimer = null;
  const thumbs = new Map();
  let viewport, imageData, renderedKey = '', anchor = null, dragIndex, start = null;
  let busy = false, rendering = false, working = false, dirty = false, editSession = false;
  let selectedObject = -1, gesture = null, messageTimer;
  let runsKey = '', textRuns = [], hoverRun = null, fontBytesPromise, fontFacePromise;
  const imageCache = new Map();
  const uid = () => Math.random().toString(36).slice(2, 10);
  // Same TTF is used for on-screen preview and for embedding into the saved PDF, so text lines up exactly.
  function fontBytes() {
    return fontBytesPromise ||= fetch(new URL('vendor/fonts/Pretendard-Regular.ttf', location.href))
      .then(r => { if (!r.ok) throw new Error('편집용 폰트를 불러오지 못했습니다.'); return r.arrayBuffer(); })
      .catch(e => { fontBytesPromise = null; throw e; });
  }
  function editorFont() {
    return fontFacePromise ||= fontBytes().then(async buf => { const face = new FontFace('PretendardEdit', buf.slice(0)); await face.load(); document.fonts.add(face); })
      .catch(e => { fontFacePromise = null; throw e; });
  }
  function baselineOffset(size) {
    const ctx = overlay.getContext('2d'); ctx.save(); ctx.font = `${size}px ${FONT}`; ctx.textBaseline = 'top';
    const m = ctx.measureText('가Ag'); ctx.restore(); return Math.abs(m.alphabeticBaseline);
  }
  const locked = () => busy || rendering || working;
  const mode = () => workspace.dataset.mode;
  const tool = () => $('editTool').value;
  const current = () => pages[active];
  const currentItem = () => current()?.items[selectedObject];
  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // A document can mix pages from several PDFs (inserted files, blank pages): each page points at sources[p.src].
  const pdfPage = p => sources[p.src].doc.getPage(p.original + 1);
  const pageKey = p => `${p.src}:${p.original}:${p.rotation}`;
  const thumbKey = p => `${p.src}:${p.original}`;
  function sourceLabel(p) {
    const s = sources[p.src]; if (!s) return '';
    if (s.blank) return '빈 페이지';
    if (p.src === 0) return `원본 ${p.original + 1}`;
    const short = baseName(s.name); return `${short.length > 10 ? short.slice(0, 9) + '…' : short} ${p.original + 1}`;
  }
  async function addSource(bytes, name, blank = false) {
    const lib = await PDFLib.PDFDocument.load(bytes);
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    sources.push({ name, lib, doc, bytes, blank }); return sources.length - 1;
  }
  const newPage = (src, original) => ({ id: nextId++, src, original, rotation: 0, items: [] });

  // ---------- history ----------
  const snapshot = () => ({ pages: clone(pages), active, selected: [...selected] });
  function remember() { undo.push(snapshot()); if (undo.length > 60) undo.shift(); redo = []; dirty = true; scheduleAutosave(); }
  function restore(from, to) {
    if (!from.length) return;
    to.push(snapshot()); const s = from.pop();
    pages = s.pages; active = Math.min(s.active, pages.length - 1); selected = new Set(s.selected); dirty = true; scheduleAutosave();
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
      ? '클릭으로 선택 · Shift+클릭 범위 선택 · 드래그로 순서 변경(선택한 페이지는 함께 이동, 휴대폰은 길게 누른 뒤 끌기) · 더블클릭하면 내용 편집'
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
      const card = document.createElement('div'); card.className = 'page-card'; card.draggable = true; card.dataset.index = i; card.dataset.thumb = thumbKey(p);
      const check = document.createElement('input'); check.type = 'checkbox'; check.setAttribute('aria-label', `${i + 1}페이지 선택`);
      check.onchange = () => { if (locked()) { check.checked = selected.has(p.id); return; } toggleSelect(i, { shiftKey: false }, check.checked); };
      const open = document.createElement('button'); open.type = 'button'; open.className = 'page-open';
      open.setAttribute('aria-label', `${i + 1}페이지 (${sourceLabel(p)})`);
      const frame = document.createElement('span'); frame.className = 'page-thumb';
      const img = document.createElement('img'); if (thumbs.has(thumbKey(p))) img.src = thumbs.get(thumbKey(p)); img.alt = ''; img.draggable = false;
      if (p.rotation) img.style.transform = `rotate(${p.rotation}deg)${p.rotation % 180 ? ' scale(.72)' : ''}`;
      frame.append(img);
      if (p.items.length) { const badge = document.createElement('em'); badge.className = 'page-badge'; badge.textContent = `편집 ${p.items.length}`; frame.append(badge); }
      const label = document.createElement('span'); label.className = 'page-label';
      label.innerHTML = `<b>${i + 1}</b><small></small>`;
      label.querySelector('small').textContent = `${sourceLabel(p)}${p.rotation ? ` · ${p.rotation}°` : ''}${p.crop ? ' · 자름' : ''}`;
      open.append(frame, label);
      open.onclick = e => {
        if (locked() || Date.now() < suppressClickUntil) return;
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
      card.addEventListener('touchstart', e => touchStart(e, i), { passive: true });
      card.append(check, open, controls); return card;
    });
    $('editPages').replaceChildren(...cards); updateSelectionUI(); queueThumbs();
  }
  // Thumbnails are rendered in the background (visible cards first) so large PDFs open immediately.
  function queueThumbs() {
    if (thumbRun) return;
    const gen = docGen; thumbRun = true; // set before starting: the loop may finish synchronously
    (async () => {
      try {
        while (gen === docGen) {
          const cards = [...$('editPages').children].filter(c => !thumbs.has(c.dataset.thumb));
          if (!cards.length) break;
          const visible = cards.find(c => { const r = c.getBoundingClientRect(); return r.width && r.bottom > -200 && r.top < innerHeight + 200; });
          const key = (visible || cards[0]).dataset.thumb, [src, original] = key.split(':').map(Number);
          const page = await sources[src].doc.getPage(original + 1), view = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: 180 / Math.max(view.width, view.height) }), canvas = document.createElement('canvas');
          canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          if (gen !== docGen) break;
          const url = canvas.toDataURL('image/jpeg', .7); thumbs.set(key, url);
          for (const card of $('editPages').querySelectorAll(`[data-thumb="${key}"]`)) card.querySelector('.page-thumb img').src = url;
        }
      } catch (e) { if (gen === docGen) console.warn('thumbnail', e); }
      finally { thumbRun = null; }
    })();
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
  // Touch: long-press a card, then drag it (HTML drag-and-drop does not work with fingers).
  let touch = null, suppressClickUntil = 0;
  function touchStart(e, i) {
    if (mode() !== 'pages' || locked() || e.touches.length !== 1) return;
    const t = e.touches[0]; touch = { i, x: t.clientX, y: t.clientY, active: false, target: null, after: false };
    touch.timer = setTimeout(() => {
      if (!touch) return; touch.active = true; navigator.vibrate?.(12);
      const p = pages[i], group = selected.has(p.id) && selected.size > 1 ? selected.size : 1;
      const ghost = document.createElement('div'); ghost.className = 'touch-ghost';
      const img = document.createElement('img'); if (thumbs.has(thumbKey(p))) img.src = thumbs.get(thumbKey(p));
      ghost.append(img); if (group > 1) { const b = document.createElement('b'); b.textContent = group; ghost.append(b); }
      ghost.style.left = `${touch.x}px`; ghost.style.top = `${touch.y}px`; document.body.append(ghost); touch.ghost = ghost;
      $('editPages').children[i]?.classList.add('is-dragging');
    }, 380);
  }
  function touchEnd() {
    if (!touch) return; clearTimeout(touch.timer);
    const t = touch; touch = null; t.ghost?.remove(); clearDrop();
    if (t.active) { suppressClickUntil = Date.now() + 400; if (t.target !== null) action(() => dropPages(t.i, t.target, t.after))(); }
  }
  document.addEventListener('touchmove', e => {
    if (!touch) return; const t = e.touches[0];
    if (!touch.active) { if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 10) { clearTimeout(touch.timer); touch = null; } return; }
    e.preventDefault(); touch.ghost.style.left = `${t.clientX}px`; touch.ghost.style.top = `${t.clientY}px`;
    const card = document.elementFromPoint(t.clientX, t.clientY)?.closest('.page-card');
    for (const c of $('editPages').children) c.classList.remove('drop-before', 'drop-after');
    if (card && $('editPages').contains(card)) { touch.target = Number(card.dataset.index); touch.after = dropAfter(card, t); card.classList.add(touch.after ? 'drop-after' : 'drop-before'); }
    else touch.target = null;
    if (t.clientY < 60) scrollBy(0, -12); else if (t.clientY > innerHeight - 60) scrollBy(0, 12);
  }, { passive: false });
  document.addEventListener('touchend', touchEnd); document.addEventListener('touchcancel', touchEnd);
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
    if (kind === 'original') next.sort((a, b) => a.src - b.src || a.original - b.original);
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
      const pg = await pdfPage(p); const vp = pg.getViewport({ scale: 1, rotation: (pg.rotate + p.rotation) % 360 });
      if (p.crop) p.crop = { x: vp.height - p.crop.y - p.crop.h, y: p.crop.x, w: p.crop.h, h: p.crop.w };
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
      const key = pageKey(p);
      if (key !== renderedKey) {
        const page = await pdfPage(p);
        viewport = page.getViewport({ scale: 1, rotation: (page.rotate + p.rotation) % 360 });
        const renderViewport = page.getViewport({ scale: SCALE, rotation: viewport.rotation });
        const base = $('editBase'), next = document.createElement('canvas');
        next.width = Math.ceil(renderViewport.width); next.height = Math.ceil(renderViewport.height);
        await page.render({ canvasContext: next.getContext('2d'), viewport: renderViewport }).promise;
        base.width = overlay.width = next.width; base.height = overlay.height = next.height;
        base.getContext('2d').drawImage(next, 0, 0); renderedKey = key; applyZoom();
      }
      if (selectedObject >= p.items.length) selectObject(-1);
      await editorFont(); await prepareImages(p.items);
      if (tool() === 'retext') await loadRuns();
      redraw(); selectionSettings();
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
  function draw(ctx, item, scale, onScreen = true) {
    ctx.save(); ctx.scale(scale, scale); ctx.translate(item.x, item.y); ctx.rotate((item.angle || 0) * Math.PI / 180);
    if (item.kind === 'text') {
      ctx.font = `${item.size}px ${FONT}`; ctx.textBaseline = 'top'; ctx.fillStyle = item.color; ctx.globalAlpha = item.opacity ?? 1;
      lines(item).forEach((line, k) => ctx.fillText(line, 0, k * item.size * LINE));
    } else if (item.kind === 'image') {
      const image = imageCache.get(item.data); if (image) ctx.drawImage(image, 0, 0, item.w, item.h);
    } else {
      ctx.fillStyle = item.kind === 'cover' ? '#ffffff' : item.color;
      ctx.globalAlpha = item.kind === 'highlight' ? 0.3 : 1; ctx.fillRect(0, 0, item.w, item.h);
      if (onScreen && item.redact) { ctx.globalAlpha = 1; ctx.strokeStyle = '#d9534a'; ctx.lineWidth = .8; ctx.setLineDash([3, 2]); ctx.strokeRect(.4, .4, item.w - .8, item.h - .8); }
    }
    ctx.restore();
  }
  async function prepareImages(entries) {
    for (const item of entries) if (item.kind === 'image' && !imageCache.has(item.data)) {
      const img = new Image(); img.src = item.data; await img.decode(); imageCache.set(item.data, img);
    }
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
    if (tool() === 'retext') for (const run of textRuns) {
      ctx.save(); ctx.scale(SCALE, SCALE); ctx.translate(run.x, run.y); ctx.rotate(run.angle);
      const on = run === hoverRun; ctx.fillStyle = on ? 'rgba(255,170,30,.22)' : 'rgba(255,170,30,.07)'; ctx.fillRect(0, 0, run.w, run.h);
      if (on) { ctx.strokeStyle = '#e38b12'; ctx.lineWidth = 1.2 * pxToPt(); ctx.strokeRect(0, 0, run.w, run.h); }
      ctx.restore();
    }
    current().items.forEach((item, i) => draw(ctx, gesture && i === selectedObject ? gesture.draft : item, SCALE));
    const crop = current().crop;
    if (crop && !(draft && tool() === 'crop')) {
      ctx.save(); ctx.scale(SCALE, SCALE); ctx.fillStyle = 'rgba(22,32,58,.42)'; ctx.beginPath(); ctx.rect(0, 0, viewport.width, viewport.height); ctx.rect(crop.x, crop.y, crop.w, crop.h); ctx.fill('evenodd');
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2 * pxToPt(); ctx.setLineDash([5 * pxToPt(), 4 * pxToPt()]); ctx.strokeRect(crop.x, crop.y, crop.w, crop.h); ctx.restore();
    }
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
    hoverRun = null; selectionSettings(); redraw();
    if (next === 'retext') action(async () => {
      await loadRuns(); redraw();
      if (!textRuns.length) notify('이 페이지에서 고칠 수 있는 글자를 찾지 못했습니다. 스캔한 문서라면 가리기 + 텍스트를 이용하세요.', true);
    })();
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
    $('editRedactField').hidden = kind !== 'cover';
    $('editCropField').hidden = tool() !== 'crop' || !!item; $('editCropClear').disabled = !current()?.crop; $('editCropAll').disabled = !current()?.crop;
    $('editSelection').hidden = !item; if (!item) $('editCopyForm').hidden = true;
    $('editSelectionLabel').textContent = item ? (item.redact ? '영구 삭제 영역 선택됨' : LABEL[kind]) : NEW_LABEL[tool()];
    document.querySelector('.edit-controls').classList.toggle('is-selected', !!item);
    if (item) {
      if (kind === 'text') { setValue($('editText'), item.text); setValue($('editSize'), item.size); }
      if (item.color) setValue($('editColor'), item.color);
      if (kind !== 'text') setValue($('editObjectWidth'), Math.round(item.w));
      if (kind === 'cover') $('editRedact').checked = !!item.redact;
    }
    $('editHelp').textContent = TOOL_HELP[tool()];
    overlay.style.cursor = tool() === 'select' ? 'default' : tool() === 'retext' ? 'text' : 'crosshair';
  }
  function liveEdit() {
    const item = currentItem(); if (!item || locked()) return;
    const next = { ...item };
    if (item.kind === 'text') {
      const size = Number($('editSize').value); if ($('editText').value.trim()) next.text = $('editText').value.replace(/\s+$/, '');
      if (Number.isFinite(size) && size >= MIN_SIZE && size <= MAX_SIZE) next.size = size;
    } else {
      const w = Number($('editObjectWidth').value);
      if (Number.isFinite(w) && w >= 3 && w <= Math.max(viewport.width, viewport.height)) { next.h = item.h * w / item.w; next.w = w; }
    }
    if (['text', 'highlight'].includes(item.kind)) next.color = $('editColor').value;
    if (item.kind === 'cover') next.redact = $('editRedact').checked;
    if (JSON.stringify(next) === JSON.stringify(item)) return;
    if (!editSession) { remember(); editSession = true; }
    current().items[selectedObject] = next; redraw(); count();
  }
  for (const id of ['editText', 'editSize', 'editColor', 'editObjectWidth', 'editRedact']) $(id).addEventListener('input', liveEdit);
  $('editRedact').addEventListener('change', () => { editSession = false; selectionSettings(); redraw(); });
  for (const id of ['editText', 'editSize', 'editObjectWidth']) $(id).addEventListener('change', () => { editSession = false; selectionSettings(); });
  $('editText').addEventListener('input', () => { const t = $('editText'); t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; });
  $('editText').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); editSession = false; overlay.focus({ preventScroll: true }); } };
  function removeObject() {
    if (!currentItem()) return;
    const item = currentItem(); remember(); const items = current().items;
    items.splice(selectedObject, 1);
    if (item.cover) { const k = items.findIndex(it => it.uid === item.cover); if (k >= 0) items.splice(k, 1); }
    selectObject(-1); redraw(); selectionSettings(); renderCards();
  }
  function duplicateObject() {
    const item = currentItem(); if (!item) return;
    remember(); const copy = { ...item, uid: uid(), cover: undefined, x: Math.min(item.x + 12, viewport.width - 6), y: Math.min(item.y + 12, viewport.height - 6) };
    current().items.push(copy); selectObject(current().items.length - 1); redraw(); selectionSettings(); renderCards();
  }
  $('editRemove').onclick = action(removeObject); $('editDuplicate').onclick = action(duplicateObject);
  $('editImage').onchange = action(async () => {
    imageData = null; const f = $('editImage').files[0]; if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type)) throw new Error('PNG 또는 JPG 이미지를 선택하세요.');
    imageData = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f); });
    $('editImage').value = ''; addStamp(imageData);
    if (tool() !== 'image') setTool('image');
    notify('페이지를 클릭하거나 드래그해 넣으세요.');
  });

  // ---------- signature & stamp library (localStorage, this browser only) ----------
  const STAMP_KEY = 'pdfWorkbench.stamps.v1';
  const loadStamps = () => { try { return JSON.parse(localStorage.getItem(STAMP_KEY) || '[]'); } catch { return []; } };
  function saveStamps(list) {
    while (list.length) { try { localStorage.setItem(STAMP_KEY, JSON.stringify(list)); return; } catch { list.pop(); } }
    try { localStorage.removeItem(STAMP_KEY); } catch { /* unavailable */ }
  }
  function addStamp(data) {
    if (data.length > 900000) { renderStamps(); return; } // very large photos are used once but not kept
    const list = loadStamps().filter(st => st.data !== data); list.unshift({ id: uid(), data });
    saveStamps(list.slice(0, 12)); renderStamps();
  }
  function renderStamps() {
    const box = $('editStamps');
    box.replaceChildren(...loadStamps().map(st => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'stamp'; b.setAttribute('aria-pressed', String(st.data === imageData)); b.title = '이 서명·도장 사용';
      const img = document.createElement('img'); img.src = st.data; img.alt = '저장된 서명·도장';
      const x = document.createElement('span'); x.className = 'stamp-remove'; x.textContent = '✕'; x.title = '보관함에서 삭제'; x.setAttribute('role', 'button');
      x.onclick = e => { e.stopPropagation(); saveStamps(loadStamps().filter(o => o.id !== st.id)); if (imageData === st.data) imageData = null; renderStamps(); };
      b.onclick = () => { imageData = st.data; if (tool() !== 'image') setTool('image'); renderStamps(); notify('페이지를 클릭하거나 드래그해 넣으세요.'); };
      b.append(img, x); return b;
    }));
  }
  const pad = $('signPad'), pctx = pad.getContext('2d'); let pen = null, inked = false;
  const padPoint = e => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
  $('editSignDraw').onclick = () => { pctx.clearRect(0, 0, pad.width, pad.height); inked = false; $('signError').hidden = true; $('signDialog').showModal(); };
  $('signClear').onclick = () => { pctx.clearRect(0, 0, pad.width, pad.height); inked = false; };
  $('signCancel').onclick = () => $('signDialog').close();
  pad.onpointerdown = e => {
    pad.setPointerCapture(e.pointerId); pen = padPoint(e); inked = true; $('signError').hidden = true;
    pctx.strokeStyle = pctx.fillStyle = document.querySelector('[name=signColor]:checked').value; pctx.lineWidth = 6; pctx.lineCap = pctx.lineJoin = 'round';
    pctx.beginPath(); pctx.arc(pen.x, pen.y, 3, 0, Math.PI * 2); pctx.fill(); pctx.beginPath(); pctx.moveTo(pen.x, pen.y);
  };
  pad.onpointermove = e => {
    if (!pen) return; const p = padPoint(e), mid = { x: (pen.x + p.x) / 2, y: (pen.y + p.y) / 2 };
    pctx.quadraticCurveTo(pen.x, pen.y, mid.x, mid.y); pctx.stroke(); pctx.beginPath(); pctx.moveTo(mid.x, mid.y); pen = p;
  };
  pad.onpointerup = pad.onpointercancel = () => { pen = null; };
  $('signUse').onclick = () => {
    if (!inked) { $('signError').hidden = false; return; }
    const d = pctx.getImageData(0, 0, pad.width, pad.height).data; let x0 = pad.width, y0 = pad.height, x1 = 0, y1 = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 10) { const x = (i >> 2) % pad.width, y = Math.floor((i >> 2) / pad.width); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 <= x0) { $('signError').hidden = false; return; }
    const m = 8, out = document.createElement('canvas'); out.width = x1 - x0 + m * 2; out.height = y1 - y0 + m * 2;
    out.getContext('2d').drawImage(pad, x0 - m, y0 - m, out.width, out.height, 0, 0, out.width, out.height);
    imageData = out.toDataURL('image/png'); addStamp(imageData); $('signDialog').close();
    setTool('image'); renderStamps(); notify('페이지를 클릭하면 서명이 들어갑니다. 드래그하면 크기를 정할 수 있습니다.');
  };
  renderStamps();

  // ---------- crop ----------
  $('editCropClear').onclick = action(() => { if (!current().crop) return; remember(); delete current().crop; redraw(); selectionSettings(); renderCards(); });
  $('editCropAll').onclick = action(async () => {
    const c = current().crop; if (!c) return; remember();
    for (const p of pages) { const vp = await pageViewport(p); const x = Math.min(c.x, vp.width - 10), y = Math.min(c.y, vp.height - 10); p.crop = { x, y, w: Math.min(c.w, vp.width - x), h: Math.min(c.h, vp.height - y) }; }
    renderCards(); selectionSettings(); notify(`${pages.length}페이지에 같은 자르기 영역을 적용했습니다.`);
  });

  // ---------- copy an item to other pages ----------
  $('editCopyPages').onclick = () => { const form = $('editCopyForm'); form.hidden = !form.hidden; if (!form.hidden) $('editCopyRange').focus(); };
  $('editCopyCancel').onclick = () => { $('editCopyForm').hidden = true; };
  $('editCopyRange').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('editCopyApply').click(); } };
  $('editCopyApply').onclick = action(async () => {
    const item = currentItem(); if (!item) return;
    const raw = $('editCopyRange').value.trim();
    const targets = (raw ? parsePageRange(raw, pages.length).map(n => n - 1) : pages.map((_, i) => i)).filter(i => i !== active);
    if (!targets.length) throw new Error('복사할 다른 페이지가 없습니다.');
    remember(); const cover = item.cover && current().items.find(it => it.uid === item.cover);
    for (const i of targets) {
      const coverCopy = cover && { ...cover, uid: uid() };
      pages[i].items.push(...(coverCopy ? [coverCopy] : []), { ...item, uid: uid(), cover: coverCopy?.uid });
    }
    $('editCopyForm').hidden = true; renderCards(); notify(`${targets.length}페이지의 같은 위치에 복사했습니다.`);
  });

  // ---------- page numbers & watermark ----------
  let batchMode = 'numbers';
  function openBatch(next) {
    if (locked() || !pages.length) return;
    batchMode = next; const numbers = next === 'numbers';
    $('batchTitle').textContent = numbers ? '페이지 번호 넣기' : '워터마크 넣기';
    $('batchIntro').textContent = numbers ? '현재 페이지 순서대로 번호를 넣습니다. 다시 넣으면 기존 번호가 바뀝니다. 넣은 뒤에도 내용 편집에서 하나씩 고칠 수 있습니다.' : '페이지 가운데에 반투명 문구를 넣습니다. 다시 넣으면 기존 워터마크가 바뀝니다.';
    $('batchNumberFields').hidden = !numbers; $('batchWatermarkFields').hidden = numbers;
    $('batchRemove').textContent = numbers ? '기존 번호 지우기' : '기존 워터마크 지우기';
    $('batchTarget').querySelector('[value=selected]').disabled = !selected.size; $('batchTarget').value = selected.size ? 'selected' : 'all';
    $('batchDialog').showModal();
  }
  $('editPageNumbers').onclick = () => openBatch('numbers'); $('editWatermark').onclick = () => openBatch('watermark');
  $('batchCancel').onclick = () => $('batchDialog').close();
  $('wmOpacity').oninput = () => { $('wmOpacityValue').textContent = `${$('wmOpacity').value}%`; };
  const batchTargets = () => $('batchTarget').value === 'selected' ? pages.map((p, i) => selected.has(p.id) ? i : -1).filter(i => i >= 0) : pages.map((_, i) => i);
  function textWidth(text, size) { const ctx = overlay.getContext('2d'); ctx.save(); ctx.font = `${size}px ${FONT}`; const w = ctx.measureText(text).width; ctx.restore(); return w; }
  async function pageViewport(p) { const pg = await pdfPage(p); return pg.getViewport({ scale: 1, rotation: (pg.rotate + p.rotation) % 360 }); }
  $('batchApply').onclick = action(async () => {
    const numbers = batchMode === 'numbers', tag = numbers ? 'pagenum' : 'watermark', targets = batchTargets();
    if (!targets.length) throw new Error('적용할 페이지가 없습니다.');
    const wmText = $('wmText').value.trim(); if (!numbers && !wmText) throw new Error('워터마크 문구를 입력하세요.');
    await editorFont(); await document.fonts.ready; remember(); let added = 0;
    for (const i of targets) {
      const p = pages[i], vp = await pageViewport(p); p.items = p.items.filter(it => it.tag !== tag);
      if (numbers) {
        if ($('numSkipFirst').checked && i === 0) continue;
        const start = Number($('numStart').value) || 0, size = clamp(Number($('numSize').value) || 10, 6, 48);
        const text = $('numFormat').value.replace('{n}', i + start).replace('{total}', pages.length + start - 1);
        const w = textWidth(text, size), h = size * LINE, margin = 26, pos = $('numPosition').value;
        const x = pos.endsWith('c') ? (vp.width - w) / 2 : pos.endsWith('r') ? vp.width - margin - w : margin;
        const y = pos.startsWith('t') ? margin * .8 : vp.height - margin - h;
        p.items.push({ kind: 'text', uid: uid(), tag, text, size, color: $('numColor').value, angle: 0, x, y });
      } else {
        const angle = Number($('wmAngle').value), a = angle * Math.PI / 180;
        let size = clamp(Number($('wmSize').value) || 72, 12, 200), w = textWidth(wmText, size);
        const limit = (angle ? Math.hypot(vp.width, vp.height) * .75 : vp.width * .85); if (w > limit) { size = Math.max(12, size * limit / w); w = textWidth(wmText, size); }
        const h = size * LINE, cx = vp.width / 2, cy = vp.height / 2;
        const x = cx - (w / 2 * Math.cos(a) - h / 2 * Math.sin(a)), y = cy - (w / 2 * Math.sin(a) + h / 2 * Math.cos(a));
        p.items.unshift({ kind: 'text', uid: uid(), tag, text: wmText, size: Math.round(size * 10) / 10, color: $('wmColor').value, opacity: Number($('wmOpacity').value) / 100, angle, x, y });
      }
      added++;
    }
    $('batchDialog').close(); await refresh();
    notify(`${added}페이지에 ${numbers ? '페이지 번호' : '워터마크'}를 넣었습니다.`);
  });
  $('batchRemove').onclick = action(async () => {
    const tag = batchMode === 'numbers' ? 'pagenum' : 'watermark', targets = batchTargets();
    if (!targets.some(i => pages[i].items.some(it => it.tag === tag))) { $('batchDialog').close(); return notify('지울 항목이 없습니다.'); }
    remember(); for (const i of targets) pages[i].items = pages[i].items.filter(it => it.tag !== tag);
    $('batchDialog').close(); await refresh(); notify(batchMode === 'numbers' ? '페이지 번호를 지웠습니다.' : '워터마크를 지웠습니다.');
  });

  // ---------- existing text (원문 수정) ----------
  async function loadRuns() {
    const p = current(); const key = pageKey(p);
    if (key === runsKey) return textRuns;
    const page = await pdfPage(p); const content = await page.getTextContent();
    textRuns = content.items.filter(it => it.str && it.str.trim() && it.transform && it.width > 0).map(it => {
      const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
      const angle = Math.atan2(tx[1], tx[0]), size = Math.hypot(tx[2], tx[3]), style = content.styles[it.fontName] || {};
      const ascentRatio = style.ascent || (style.descent ? 1 + style.descent : .8), descentRatio = Math.abs(style.descent ?? -.2);
      const asc = size * ascentRatio, sin = Math.sin(angle), cos = Math.cos(angle);
      return { str: it.str, angle, size, bx: tx[4], by: tx[5], x: tx[4] + asc * sin, y: tx[5] - asc * cos, w: it.width * viewport.scale, h: size * (ascentRatio + descentRatio) };
    }).filter(r => r.size > 1 && r.w > 1);
    runsKey = key; hoverRun = null; return textRuns;
  }
  const runAt = pos => textRuns.findLast(run => { const l = local({ x: run.x, y: run.y, angle: run.angle * 180 / Math.PI }, pos); return l.x >= -1 && l.x <= run.w + 1 && l.y >= -1 && l.y <= run.h + 1; });
  function sampleColor(run) {
    const base = $('editBase'), xs = [], ys = [], sin = Math.sin(run.angle), cos = Math.cos(run.angle);
    for (const [lx, ly] of [[0, 0], [run.w, 0], [0, run.h], [run.w, run.h]]) { xs.push((run.x + lx * cos - ly * sin) * SCALE); ys.push((run.y + lx * sin + ly * cos) * SCALE); }
    const x0 = clamp(Math.floor(Math.min(...xs)), 0, base.width - 1), y0 = clamp(Math.floor(Math.min(...ys)), 0, base.height - 1);
    const w = clamp(Math.ceil(Math.max(...xs)) - x0, 1, base.width - x0), h = clamp(Math.ceil(Math.max(...ys)) - y0, 1, base.height - y0);
    const d = base.getContext('2d').getImageData(x0, y0, w, h).data; let best = [0, 0, 0], lum = 765;
    for (let i = 0; i < d.length; i += 4) { const l = d[i] + d[i + 1] + d[i + 2]; if (d[i + 3] > 128 && l < lum) { lum = l; best = [d[i], d[i + 1], d[i + 2]]; } }
    if (lum > 600) best = [0, 0, 0];
    return '#' + best.map(v => v.toString(16).padStart(2, '0')).join('');
  }
  async function replaceRun(run) {
    await document.fonts.ready;
    const deg = run.angle * 180 / Math.PI, sin = Math.sin(run.angle), cos = Math.cos(run.angle), pad = Math.max(.8, run.size * .08);
    const cover = { kind: 'cover', uid: uid(), x: run.x - pad * cos + pad * sin, y: run.y - pad * sin - pad * cos, w: run.w + pad * 2, h: run.h + pad * 2, angle: deg, redact: false };
    const size = clamp(Math.round(run.size * 10) / 10, MIN_SIZE, MAX_SIZE), off = baselineOffset(size);
    const text = { kind: 'text', uid: uid(), cover: cover.uid, text: run.str.replace(/\s+$/, ''), size, color: sampleColor(run), angle: deg, x: run.bx + off * sin, y: run.by - off * cos };
    remember(); current().items.push(cover, text);
    $('editTool').value = 'select'; for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === 'select'));
    hoverRun = null; selectObject(current().items.length - 1); editSession = false; redraw(); selectionSettings(); renderCards();
    const focusText = () => { $('editText').focus(); $('editText').select(); };
    focusText(); setTimeout(focusText, 0);
  }

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
    if (tool() === 'retext') {
      e.preventDefault(); // keep focus free for the text box that opens
      const run = runAt(start); start = null;
      if (run) action(replaceRun)(run); else notify('주황색으로 표시된 글자를 클릭하세요.', true);
      return;
    }
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
    if (!start && tool() === 'retext') {
      const run = runAt(pos) || null; if (run !== hoverRun) { hoverRun = run; redraw(); }
      overlay.style.cursor = run ? 'text' : 'default'; return;
    }
    if (!start) {
      const sel = tool() === 'select' && currentItem();
      overlay.style.cursor = sel && onHandle(sel, pos) ? 'nwse-resize' : tool() !== 'select' ? 'crosshair' : current()?.items.some(it => hit(it, pos)) ? 'move' : 'default';
      return;
    }
    if (locked()) return;
    if (gesture?.kind === 'move') { gesture.draft.x = gesture.original.x + pos.x - start.x; gesture.draft.y = gesture.original.y + pos.y - start.y; redraw(); }
    else if (gesture?.kind === 'resize') {
      const o = gesture.original, l = local(o, pos), d = gesture.draft;
      if (o.kind === 'text') d.size = Math.round(clamp(o.size * (l.x - 2) / gesture.size.w, MIN_SIZE, MAX_SIZE) * 10) / 10;
      else { d.w = Math.max(3, l.x - 2); d.h = o.kind === 'image' ? d.w * o.h / o.w : Math.max(3, l.y - 2); }
      redraw();
    } else if (['cover', 'highlight', 'image', 'crop'].includes(tool())) {
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
    if (kind === 'crop') {
      const crop = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
      if (crop.w < 10 || crop.h < 10) { redraw(); return notify('남길 영역을 드래그하세요.', true); }
      remember(); current().crop = crop; redraw(); selectionSettings(); renderCards(); return;
    }
    await action(async () => {
      const item = { kind, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y), color: $('editColor').value, angle: 0 };
      let placeholder = false;
      if (kind === 'text') {
        const typed = $('editText').value.replace(/\s+$/, ''); placeholder = !typed.trim();
        item.text = placeholder ? '텍스트' : typed; item.size = clamp(Number($('editSize').value) || 16, MIN_SIZE, MAX_SIZE); item.x = a.x; item.y = a.y;
        delete item.w; delete item.h; await document.fonts.ready;
      } else {
        if (kind === 'image') {
          if (!imageData) throw new Error('먼저 서명을 그리거나 저장된 서명·이미지를 고르세요.');
          const img = new Image(); img.src = imageData; await img.decode();
          if (item.w < 3 || item.h < 3) { // click: default size centred on the click
            item.w = Math.min(150, viewport.width * .3, img.width); item.h = item.w * img.height / img.width;
            item.x = clamp(a.x - item.w / 2, 0, Math.max(0, viewport.width - item.w)); item.y = clamp(a.y - item.h / 2, 0, Math.max(0, viewport.height - item.h));
          } else { const factor = Math.min(item.w / img.width, item.h / img.height); item.w = img.width * factor; item.h = img.height * factor; }
          item.data = imageData; delete item.color;
        } else if (item.w < 3 || item.h < 3) throw new Error('마우스로 드래그해 영역을 지정하세요.');
        if (kind === 'cover') { delete item.color; item.redact = $('editRedact').checked; }
      }
      item.uid = uid(); await prepareImages([item]); remember(); current().items.push(item);
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
    if (!panel.classList.contains('is-active') || !pages.length || locked() || document.querySelector('dialog[open]')) return;
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
    const shortcuts = { v: 'select', r: 'retext', t: 'text', e: 'cover', h: 'highlight', i: 'image', c: 'crop' };
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
  function resetDocument() {
    docGen++; for (const src of sources) src.doc.destroy().catch(() => {});
    sources = []; pages = []; thumbs.clear(); renderedKey = ''; runsKey = ''; viewport = null; nextId = 0;
    active = 0; selected.clear(); anchor = null; undo = []; redo = []; imageData = null; dirty = false; imageCache.clear();
  }
  async function showDocument(fileName) {
    $('editImage').value = ''; $('editZoom').value = 'fit'; workspace.hidden = false; $('editorDrop').classList.add('has-document'); $('editRestore').hidden = true;
    setMode('pages'); setTool('select'); await refresh();
    $('editorStatus').textContent = `${fileName} · ${pages.length}페이지 · 원본 파일은 변경되지 않습니다.`;
  }
  function openFiles(files) {
    if (!files.length || locked()) return;
    if (dirty && !confirm('저장하지 않은 편집 내용이 있습니다. 새 PDF를 열면 사라집니다. 계속할까요?')) return;
    return action(async () => {
      if (files.length !== 1) throw new Error('편집할 PDF 한 개만 놓아 주세요. 다른 PDF는 열고 난 뒤 \'PDF 끼워넣기\'로 추가할 수 있습니다.');
      const file = files[0];
      if (!isPdf(file)) throw new Error('PDF 파일을 선택하거나 끌어다 놓아 주세요.');
      busy = true; $('editorStatus').textContent = 'PDF를 불러오는 중…';
      try {
        requireLibraries();
        const bytes = new Uint8Array(await file.arrayBuffer());
        await PDFLib.PDFDocument.load(bytes); // validate before discarding the current document
        resetDocument();
        const src = await addSource(bytes, file.name);
        pages = Array.from({ length: sources[src].doc.numPages }, (_, i) => newPage(src, i));
        $('editName').value = `${baseName(file.name)}_edited.pdf`;
        await showDocument(file.name); persistSources(); scheduleAutosave();
      } catch (e) { throw new Error(`PDF를 열지 못했습니다. 암호가 있으면 잠금 해제 후 열어 주세요. ${e.message}`); }
      finally { busy = false; }
    })();
  }

  // ---------- insert pages ----------
  function insertionIndex() {
    const picked = pages.map((p, i) => selected.has(p.id) ? i : -1).filter(i => i >= 0);
    return (picked.length ? Math.max(...picked) : active) + 1;
  }
  async function insertPages(newPages, at) {
    remember(); pages.splice(at, 0, ...newPages); selected = new Set(newPages.map(p => p.id)); anchor = at; active = at; await refresh();
  }
  $('editInsertBlank').onclick = action(async () => {
    const ref = current(), pg = await pdfPage(ref), vp = pg.getViewport({ scale: 1, rotation: pg.rotate });
    const doc = await PDFLib.PDFDocument.create(); doc.addPage([vp.width, vp.height]);
    const src = await addSource(new Uint8Array(await doc.save()), '빈 페이지', true);
    await insertPages([newPage(src, 0)], insertionIndex()); persistSources();
    notify('빈 페이지를 추가했습니다.');
  });
  $('editInsertPdf').onclick = () => { if (!locked()) $('editInsertInput').click(); };
  $('editInsertInput').onchange = action(async () => {
    const files = Array.from($('editInsertInput').files).filter(isPdf); $('editInsertInput').value = '';
    if (!files.length) return;
    busy = true;
    try {
      const added = [];
      for (const file of files) {
        let src;
        try { src = await addSource(new Uint8Array(await file.arrayBuffer()), file.name); }
        catch (e) { throw new Error(`${file.name}을(를) 열지 못했습니다. 암호가 걸린 PDF는 잠금 해제 후 추가하세요.`); }
        for (let i = 0; i < sources[src].doc.numPages; i++) added.push(newPage(src, i));
      }
      busy = false; await insertPages(added, insertionIndex()); persistSources();
      notify(`${files.length}개 PDF에서 ${added.length}페이지를 끼워 넣었습니다.`);
    } finally { busy = false; }
  });

  // ---------- autosave (IndexedDB, this browser only) ----------
  const DB_NAME = 'pdf-workbench-editor';
  function idb(modeRW, fn) {
    return new Promise((resolve, reject) => {
      let req; try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => req.result.createObjectStore('session');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('session', modeRW), store = tx.objectStore('session'); let result;
        Promise.resolve(fn(store)).then(r => { result = r; });
        tx.oncomplete = () => { db.close(); resolve(result); }; tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const idbGet = key => idb('readonly', store => new Promise(r => { const q = store.get(key); q.onsuccess = () => r(q.result); q.onerror = () => r(undefined); }));
  function persistSources() {
    const data = sources.map(s => ({ name: s.name, blank: s.blank, bytes: s.bytes }));
    idb('readwrite', store => { store.put(data, 'sources'); }).catch(() => {});
  }
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      if (!pages.length) return;
      const state = { pages, active, name: $('editName').value, fileName: sources[0]?.name, dirty, savedAt: Date.now() };
      idb('readwrite', store => { store.put(clone(state), 'state'); }).catch(() => {});
    }, 800);
  }
  async function offerRestore() {
    try {
      const state = await idbGet('state'); if (!state?.dirty || pages.length) return;
      const when = new Date(state.savedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      $('editRestoreText').textContent = `저장하지 않은 편집 작업이 있습니다 · ${state.fileName || 'PDF'} · ${when}`;
      $('editRestore').hidden = false;
    } catch { /* storage unavailable */ }
  }
  $('editRestoreYes').onclick = action(async () => {
    const [state, saved] = [await idbGet('state'), await idbGet('sources')];
    if (!state || !saved?.length) { $('editRestore').hidden = true; throw new Error('이전 작업을 찾지 못했습니다.'); }
    busy = true;
    try {
      resetDocument();
      for (const s of saved) await addSource(new Uint8Array(s.bytes), s.name, s.blank);
      pages = state.pages; nextId = Math.max(...pages.map(p => p.id)) + 1; active = clamp(state.active || 0, 0, pages.length - 1);
      $('editName').value = state.name || 'edited.pdf'; dirty = true;
      await showDocument(state.fileName || 'PDF'); notify('이전 작업을 불러왔습니다.');
    } finally { busy = false; }
  });
  $('editRestoreNo').onclick = () => { $('editRestore').hidden = true; idb('readwrite', store => { store.clear(); }).catch(() => {}); };
  $('editName').addEventListener('change', scheduleAutosave);
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
  const hexRgb = hex => { const n = parseInt(String(hex || '#000000').slice(1), 16); return PDFLib.rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };
  // Draws items as real PDF objects (selectable/searchable text, crisp shapes). toPdf maps view coordinates (pt, y down) to PDF user space.
  async function drawVector(output, page, items, toPdf, font, images) {
    for (const item of items) {
      const a = (item.angle || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      const P = (lx, ly) => toPdf(item.x + lx * cos - ly * sin, item.y + lx * sin + ly * cos);
      const o = P(0, 0), u = P(1, 0), rotate = PDFLib.degrees(Math.atan2(u[1] - o[1], u[0] - o[0]) * 180 / Math.PI);
      if (item.kind === 'text') {
        const off = baselineOffset(item.size);
        lines(item).forEach((line, k) => { if (!line.trim()) return; const [x, y] = P(0, off + k * item.size * LINE); page.drawText(line, { x, y, size: item.size, font, color: hexRgb(item.color), rotate, opacity: item.opacity ?? 1 }); });
        continue;
      }
      const [x, y] = P(0, item.h);
      if (item.kind === 'image') {
        if (!images.has(item.data)) images.set(item.data, item.data.startsWith('data:image/png') ? await output.embedPng(item.data) : await output.embedJpg(item.data));
        page.drawImage(images.get(item.data), { x, y, width: item.w, height: item.h, rotate });
      } else {
        page.drawRectangle({ x, y, width: item.w, height: item.h, rotate, color: item.kind === 'cover' ? PDFLib.rgb(1, 1, 1) : hexRgb(item.color), opacity: item.kind === 'highlight' ? 0.3 : 1, borderWidth: 0 });
      }
    }
  }
  function applyCrop(page, p, toPdf) {
    if (!p.crop) return;
    const [ax, ay] = toPdf(p.crop.x, p.crop.y), [bx, by] = toPdf(p.crop.x + p.crop.w, p.crop.y + p.crop.h);
    page.setCropBox(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
  }
  async function save(onlySelected, separate = false) {
    if (onlySelected) requireSelection();
    busy = true; $('editorStatus').textContent = 'PDF를 저장하는 중…';
    try {
      const output = await PDFLib.PDFDocument.create(); const chosen = pages.filter(p => !onlySelected || selected.has(p.id));
      let font = null; const images = new Map();
      if (chosen.some(p => p.items.some(it => it.kind === 'text'))) {
        if (!window.fontkit) throw new Error('글꼴 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.');
        await editorFont(); output.registerFontkit(window.fontkit);
        const bytes = await fontBytes(); const parsed = window.fontkit.create(new Uint8Array(bytes));
        const chars = new Set(chosen.flatMap(p => p.items.filter(it => it.kind === 'text').map(it => it.text)).join(''));
        const ids = [...chars].map(ch => parsed.glyphForCodePoint(ch.codePointAt(0)).id);
        font = await output.embedFont(subsetTrueType(bytes, ids), { subset: false });
      }
      let redacted = 0;
      for (const p of chosen) {
        const rotation = (sources[p.src].lib.getPage(p.original).getRotation().angle + p.rotation) % 360;
        const pg = await pdfPage(p); const vp = pg.getViewport({ scale: 1, rotation });
        const lastRedaction = p.items.findLastIndex(it => it.kind === 'cover' && it.redact);
        if (lastRedaction >= 0) {
          // Permanent removal: the page is re-rendered as an image with the areas painted out, so the original text no longer exists.
          const R = 2.5, rvp = pg.getViewport({ scale: R, rotation }), canvas = document.createElement('canvas');
          canvas.width = Math.ceil(rvp.width); canvas.height = Math.ceil(rvp.height);
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await pg.render({ canvasContext: ctx, viewport: rvp }).promise;
          // Everything stacked at or below the last redaction is flattened into the image (same order as on screen),
          // so text hidden under a redaction is removed too. Items added afterwards stay as real PDF objects.
          const flattened = p.items.slice(0, lastRedaction + 1); await editorFont(); await prepareImages(flattened);
          for (const item of flattened) draw(ctx, item, R, false);
          const img = await output.embedJpg(canvas.toDataURL('image/jpeg', .92));
          const page = output.addPage([vp.width, vp.height]); page.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
          await drawVector(output, page, p.items.slice(lastRedaction + 1), (x, y) => [x, vp.height - y], font, images);
          applyCrop(page, p, (x, y) => [x, vp.height - y]); redacted++;
        } else {
          const [page] = await output.copyPages(sources[p.src].lib, [p.original]); page.setRotation(PDFLib.degrees(rotation)); output.addPage(page);
          if (p.items.length) await drawVector(output, page, p.items, (x, y) => vp.convertToPdfPoint(x, y), font, images);
          applyCrop(page, p, (x, y) => vp.convertToPdfPoint(x, y));
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
        if (!onlySelected) { dirty = false; scheduleAutosave(); }
      }
      notify(`${chosen.length}페이지 ${separate ? 'ZIP' : onlySelected ? '추출본' : '편집본'} 저장 완료${redacted ? ` · ${redacted}페이지는 영구 삭제를 위해 이미지로 저장됨` : ''}. 원본 파일은 변경되지 않습니다.`);
    } finally { busy = false; }
  }
  $('editZip').onclick = action(() => save(true, true));
  $('editSave').onclick = action(() => save(false)); $('editExtract').onclick = action(() => save(true));
  $('editName').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('editSave').click(); } };
  setMode('pages'); selectionSettings(); offerRestore();
})();
