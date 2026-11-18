const els = {
  cdnError: document.getElementById('cdnError'),
  progressSection: document.getElementById('progressSection'),
  progressBar: document.getElementById('progressBar'),
  progressLabel: document.getElementById('progressLabel'),
  resultCard: document.getElementById('resultCard'),
  resultTitle: document.getElementById('resultTitle'),
  resultDetail: document.getElementById('resultDetail')
};

const state = {
  merge: [],
  image: [],
  jpg: [],
  compress: [],
  unlock: [],
  ocr: []
};
let taskController = null;
const disabledControls = new Map();
function checkCancelled() { taskController?.signal.throwIfAborted(); }
function uniquePdfName(name, used) {
  const base = baseName(name); let candidate = `${base}.pdf`, suffix = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base}_${suffix++}.pdf`;
  used.add(candidate.toLowerCase()); return candidate;
}
async function loadEditablePdf(bytes) {
  try { return await PDFLib.PDFDocument.load(bytes); }
  catch (error) {
    if (error instanceof PDFLib.EncryptedPDFError || /encrypted/i.test(error.message)) throw new Error('암호화된 PDF입니다. 먼저 ‘잠금 해제’ 탭에서 해제한 뒤 다시 선택하세요.');
    throw error;
  }
}
document.getElementById('cancelTask').onclick = () => taskController?.abort();

if (!window.PDFLib || !window.pdfjsLib || !window.JSZip) {
  els.cdnError.hidden = false;
}

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
}

document.querySelectorAll('.tab-button').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab-button').forEach(tab => { tab.classList.remove('is-active'); tab.setAttribute('aria-pressed', 'false'); });
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('is-active'));
    button.classList.add('is-active');
    button.setAttribute('aria-pressed', 'true');
    document.querySelector(`[data-panel="${button.dataset.tab}"]`).classList.add('is-active');
    hideResult();
  });
});

document.querySelectorAll('[data-pick]').forEach(button => {
  button.addEventListener('click', event => {
    event.stopPropagation();
    document.getElementById(button.dataset.pick).click();
  });
});

setupDrop('merge', 'mergeInput', true);
setupDrop('image', 'imageInput', true);
setupDrop('jpg', 'jpgInput', true);
setupDrop('compress', 'compressInput', true);
setupDrop('unlock', 'unlockInput', true);

document.getElementById('jpgQuality').addEventListener('input', event => {
  document.getElementById('jpgQualityValue').textContent = `${event.target.value}%`;
});

document.getElementById('compressQuality').addEventListener('input', event => {
  document.getElementById('compressQualityValue').textContent = `${event.target.value}%`;
});

document.getElementById('mergeRun').addEventListener('click', () => handle(runMerge));
document.getElementById('jpgRun').addEventListener('click', () => handle(runJpg));
document.getElementById('compressRun').addEventListener('click', () => handle(runCompress));

document.getElementById('unlockRun').addEventListener('click', () => handle(runUnlock));

function setupDrop(type, inputId, multiple) {
  const zone = document.querySelector(`[data-drop="${type}"]`);
  const input = document.getElementById(inputId);

  zone.tabIndex = 0; zone.setAttribute('role', 'button');
  zone.setAttribute('aria-label', type === 'image' ? '이미지 파일 선택' : 'PDF 파일 선택');
  zone.addEventListener('keydown', event => { if (event.target === zone && ['Enter', ' '].includes(event.key)) { event.preventDefault(); input.click(); } });
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => setFiles(type, Array.from(input.files || []), multiple));

  ['dragenter', 'dragover'].forEach(name => {
    zone.addEventListener(name, event => {
      event.preventDefault();
      zone.classList.add('is-hover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    zone.addEventListener(name, event => {
      event.preventDefault();
      zone.classList.remove('is-hover');
    });
  });

  zone.addEventListener('drop', event => {
    const files = Array.from(event.dataTransfer.files || []).filter(file => type === 'image' ? isImageFile(file) : isPdf(file));
    setFiles(type, files, multiple);
  });
}

function setFiles(type, files, multiple) {
  if (taskController) return;
  if (type === 'unlock') document.getElementById('unlockPassword').value = '';
  const accepted = files.filter(file => type === 'image' ? isImageFile(file) : isPdf(file));
  const input = document.querySelector(`[data-drop="${type}"] input[type=file]`) || document.getElementById(`${type}Input`);
  if (input) input.value = ''; // allow picking the same file again
  if (!multiple) state[type] = accepted.slice(0, 1);
  else {
    // Files are added to the list (one at a time or many at once); exact duplicates are skipped.
    const key = file => `${file.name}|${file.size}|${file.lastModified}`;
    const seen = new Set(state[type].map(key));
    const added = accepted.filter(file => !seen.has(key(file)) && seen.add(key(file)));
    state[type] = [...state[type], ...added];
    if (accepted.length && !added.length) { renderFileList(type); showResult('이미 추가된 파일', '같은 파일은 한 번만 추가됩니다.'); return; }
  }
  renderFileList(type);
  hideResult();
}

const pageCounts = new WeakMap();
async function countPages(file) {
  if (pageCounts.has(file)) return pageCounts.get(file);
  const promise = (async () => {
    try { const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; const n = doc.numPages; doc.destroy(); return n; }
    catch { return null; }
  })();
  pageCounts.set(file, promise); return promise;
}

function renderFileList(type) {
  const list = document.getElementById(`${type}List`);
  const files = state[type];
  list.innerHTML = '';
  if (files.length) {
    const head = document.createElement('li'); head.className = 'file-list__head';
    const summary = document.createElement('b'); summary.textContent = `${files.length}개 파일`;
    const actions = document.createElement('span');
    if (type === 'merge' && files.length > 1) {
      const sort = document.createElement('button'); sort.className = 'btn btn--secondary'; sort.type = 'button'; sort.textContent = '이름순 정렬';
      sort.onclick = () => { state.merge.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true })); renderFileList('merge'); };
      actions.appendChild(sort);
    }
    const clear = document.createElement('button'); clear.className = 'btn btn--secondary'; clear.type = 'button'; clear.textContent = '모두 지우기';
    clear.onclick = () => { state[type] = []; renderFileList(type); hideResult(); };
    actions.appendChild(clear); head.append(summary, actions); list.appendChild(head);
    if (type === 'merge' && window.pdfjsLib) Promise.all(files.map(countPages)).then(counts => {
      if (state.merge !== files || !summary.isConnected) return;
      const total = counts.reduce((sum, n) => sum + (n || 0), 0); summary.textContent = `${files.length}개 파일 · 총 ${total}페이지`;
    });
  }
  files.forEach((file, index) => {
    const li = document.createElement('li');
    li.innerHTML = `<b>${index + 1}. ${escapeHtml(file.name)}</b><span class="file-meta">${formatBytes(file.size)}</span>`;
    if (type === 'merge' && window.pdfjsLib) countPages(file).then(n => { if (n) li.querySelector('.file-meta').textContent = `${n}페이지 · ${formatBytes(file.size)}`; });
    const controls = document.createElement('span');
    const buttons = type === 'merge' ? [['↑', -1], ['↓', 1], ['제거', 0]] : [['제거', 0]];
    for (const [label, delta] of buttons) {
      const button = document.createElement('button');
      button.className = 'btn btn--secondary'; button.textContent = label; button.type = 'button';
      button.setAttribute('aria-label', `${file.name} ${label}`);
      button.disabled = delta !== 0 && (index + delta < 0 || index + delta >= files.length);
      button.onclick = () => {
        if (taskController || index < 0 || index >= state[type].length) return;
        if (delta && (index + delta < 0 || index + delta >= state[type].length)) return;
        if (!delta) state[type].splice(index, 1);
        else [state[type][index], state[type][index + delta]] = [state[type][index + delta], state[type][index]];
        renderFileList(type);
      };
      controls.appendChild(button);
    }
    li.appendChild(controls);
    if (type === 'merge') {
      li.draggable = true; li.classList.add('is-draggable');
      li.ondragstart = e => { e.dataTransfer.setData('text/x-merge-index', String(index)); e.dataTransfer.effectAllowed = 'move'; li.classList.add('is-dragging'); };
      li.ondragend = () => li.classList.remove('is-dragging');
      li.ondragover = e => { if (e.dataTransfer.types.includes('text/x-merge-index')) { e.preventDefault(); li.classList.add('drop-target'); } };
      li.ondragleave = () => li.classList.remove('drop-target');
      li.ondrop = e => {
        if (taskController || !e.dataTransfer.types.includes('text/x-merge-index')) return;
        const from = Number(e.dataTransfer.getData('text/x-merge-index')); li.classList.remove('drop-target');
        if (!Number.isInteger(from) || from < 0 || from >= state.merge.length || from === index) return; e.preventDefault();
        const [moved] = state.merge.splice(from, 1); state.merge.splice(index, 0, moved); renderFileList('merge');
      };
    }
    list.appendChild(li);
  });
}

async function handle(task) {
  try {
    await task();
  } catch (error) {
    const message = /encrypt|password/i.test(error.message || '') ? '암호화된 PDF입니다. 먼저 ‘잠금 해제’ 탭에서 해제한 뒤 다시 선택하세요.' : error.message || String(error);
    showResult(error.name === 'AbortError' ? '작업 취소됨' : '처리 실패', error.name === 'AbortError' ? '작업을 취소했습니다. 선택한 원본 파일은 유지됩니다.' : message, error.name !== 'AbortError');
  }
}

async function runMerge() {
  requireLibraries();
  const files = state.merge;
  if (files.length < 2) throwUserError('PDF 파일을 2개 이상 선택하세요.');

  await withBusy('PDF를 합치는 중...', async update => {
    const mergedPdf = await PDFLib.PDFDocument.create();
    for (let i = 0; i < files.length; i += 1) {
      checkCancelled();
      const sourcePdf = await loadEditablePdf(await files[i].arrayBuffer());
      const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
      update(((i + 1) / files.length) * 100, `${i + 1}/${files.length} 파일 처리 완료`);
    }
    const bytes = await mergedPdf.save({ useObjectStreams: true, addDefaultPage: false });
    const fileName = normalizePdfName(document.getElementById('mergeName').value || 'merged.pdf');
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), fileName);
    showResult('PDF 합치기 완료', `${files.length}개 PDF를 ${fileName}로 저장했습니다.`);
    offerNext([pdfFile(bytes, fileName)], 'merge');
  });
}

async function runJpg() {
  requireLibraries();
  const files = [...state.jpg];
  if (!files.length) throwUserError('이미지로 변환할 PDF를 선택하세요.');
  const format = document.getElementById('pdfImageFormat').value;
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  const range = document.getElementById('pdfImageRange').value;
  const quality = Number(document.getElementById('jpgQuality').value) / 100;
  const scale = Number(document.getElementById('jpgScale').value);
  await withBusy('PDF를 이미지로 변환하는 중...', async update => {
    const zip = new JSZip(); let done = 0; let single;
    for (let i = 0; i < files.length; i++) {
      const pdf = await pdfjsLib.getDocument({ data: await files[i].arrayBuffer() }).promise;
      try {
        const pageNumbers = parsePageRange(range, pdf.numPages);
        for (let j = 0; j < pageNumbers.length; j++) {
          const pageNo = pageNumbers[j];
          const blob = await renderPageAsJpg(pdf, pageNo, scale, quality, `image/${format}`);
          const name = `${files.length > 1 ? String(i + 1).padStart(3, '0') + '_' : ''}${baseName(files[i].name)}_p${String(pageNo).padStart(3, '0')}.${extension}`;
          zip.file(name, blob); single = { name, blob }; done++;
          update((i + (j + 1) / pageNumbers.length) / files.length * 100, `${i + 1}/${files.length} 파일 · ${j + 1}/${pageNumbers.length} 페이지`);
        }
      } finally { await pdf.destroy(); }
    }
    if (done === 1) downloadBlob(single.blob, single.name);
    else downloadBlob(await zip.generateAsync({ type: 'blob' }), `pdf_to_${extension}.zip`);
    showResult('이미지 변환 완료', `${done}개 페이지를 ${extension.toUpperCase()}로 저장했습니다.`);
  });
}

async function runCompress() {
  requireLibraries();
  const files = state.compress;
  if (!files.length) throwUserError('압축할 PDF 파일을 선택하세요.');

  await withBusy('PDF를 압축하는 중...', async update => {
    const mode = document.getElementById('compressMode').value;
    const quality = Number(document.getElementById('compressQuality').value) / 100;
    const scale = Number(document.getElementById('compressScale').value);
    const zip = files.length > 1 ? new JSZip() : null;
    let saved = 0;
    let totalInput = 0;
    let totalOutput = 0;
    const outputs = [];
    const usedNames = new Set();

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      checkCancelled();
      totalInput += file.size;
      const bytes = mode === 'raster'
        ? await rasterCompressPdf(file, quality, scale, message => {
            update(((i + message.progress) / files.length) * 100, message.label);
          })
        : await optimizePdf(file);
      totalOutput += bytes.length;
      const name = uniquePdfName(`${baseName(file.name)}_compressed.pdf`, usedNames);
      outputs.push(pdfFile(bytes, name));
      if (zip) zip.file(name, bytes);
      else downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
      saved += 1;
      update(((i + 1) / files.length) * 100, `${saved}/${files.length} 파일 압축 완료`);
    }

    if (zip) {
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `compressed_pdfs_${Date.now()}.zip`);
    }

    const ratio = totalInput ? Math.max(0, 100 - (totalOutput / totalInput * 100)) : 0;
    const detail = ratio > 0
      ? `${saved}개 파일을 압축했습니다. PDF 합계 기준 약 ${ratio.toFixed(1)}% 감소했습니다.`
      : `${saved}개 파일을 처리했습니다. 이미 압축된 PDF라 용량 감소가 거의 없을 수 있습니다.`;
    showResult('PDF 압축 완료', detail);
    offerNext(outputs, 'compress');
  });
}

async function optimizePdf(file) {
  const pdf = await loadEditablePdf(await file.arrayBuffer());
  pdf.setProducer('LVMH Fashion Group PDF Workbench');
  pdf.setCreator('LVMH Fashion Group PDF Workbench');
  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
  return bytes.length < file.size ? bytes : new Uint8Array(await file.arrayBuffer());
}

async function rasterCompressPdf(file, quality, scale, onPage) {
  const source = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
  const pdf = await PDFLib.PDFDocument.create();
  for (let pageNo = 1; pageNo <= source.numPages; pageNo += 1) {
    checkCancelled();
    const sourcePage = await source.getPage(pageNo);
    const pageSize = sourcePage.getViewport({ scale: 1 });
    const blob = await renderPageAsJpg(source, pageNo, scale, quality);
    const jpgBytes = await blob.arrayBuffer();
    const image = await pdf.embedJpg(jpgBytes);
    const page = pdf.addPage([pageSize.width, pageSize.height]);
    page.drawImage(image, { x: 0, y: 0, width: pageSize.width, height: pageSize.height });
    onPage({ progress: pageNo / source.numPages, label: `${file.name} ${pageNo}/${source.numPages} 페이지 압축 중` });
  }
  const bytes = await pdf.save({ useObjectStreams: true });
  return bytes.length < file.size ? bytes : new Uint8Array(await file.arrayBuffer());
  } finally { await source.destroy(); }
}

async function renderPageAsJpg(pdf, pageNo, scale, quality, mime = 'image/jpeg') {
  checkCancelled();
  const page = await pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (viewport.width > 16384 || viewport.height > 16384 || viewport.width * viewport.height > 64000000) throw new Error('페이지 이미지가 너무 큽니다. 해상도를 낮춰 다시 시도하세요.');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('이미지 생성에 실패했습니다. 해상도를 낮춰 주세요.')), mime, quality));
  } finally { canvas.width = canvas.height = 0; page.cleanup(); }
}

function parsePageRange(value, pageCount) {
  if (!value.trim()) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set();
  for (const part of value.split(',').map(part => part.trim())) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throwUserError(`페이지 범위를 확인하세요: ${part || '(빈 항목)'}`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) throwUserError(`페이지는 1~${pageCount} 사이로 입력하세요.`);
    const step = start <= end ? 1 : -1;
    for (let page = start; ; page += step) {
      pages.add(page);
      if (page === end) break;
    }
  }
  return Array.from(pages);
}

async function withBusy(label, task) {
  if (taskController) throw new Error('진행 중인 작업이 있습니다. 완료하거나 취소한 뒤 다시 시도하세요.');
  taskController = new AbortController();
  setBusy(true);
  updateProgress(2, label);
  try {
    await task(updateProgress);
    checkCancelled();
  } finally {
    taskController = null;
    setBusy(false);
    els.progressSection.hidden = true;
  }
}

function updateProgress(percent, label) {
  checkCancelled();
  els.progressSection.hidden = false;
  els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.progressLabel.textContent = label;
}

function setBusy(isBusy) {
  if (isBusy) {
    document.querySelectorAll('button,input,select,textarea').forEach(control => {
      if (control.id === 'cancelTask') return;
      disabledControls.set(control, control.disabled); control.disabled = true;
    });
  } else {
    disabledControls.forEach((disabled, control) => { if (control.isConnected) control.disabled = disabled; });
    disabledControls.clear();
  }
  document.getElementById('cancelTask').hidden = !isBusy;
  if (isBusy) hideResult();
}

function showResult(title, detail, isError = false) {
  els.resultCard.hidden = false;
  els.resultTitle.textContent = title;
  els.resultDetail.textContent = detail;
  els.resultCard.style.borderColor = isError ? '#c0392b' : '';
  els.resultCard.style.background = isError ? '#fdf3f2' : '';
  els.resultCard.style.color = isError ? '#c0392b' : '';
}

function hideResult() {
  els.resultCard.hidden = true;
  const next = document.getElementById('resultNext'); next.hidden = true; next.replaceChildren();
}

/* ── Continue with another tool without downloading and re-uploading ── */
const NEXT_TARGETS = [
  ['editor', '편집기에서 열기'], ['merge', '합치기에 추가'], ['compress', '압축하기'],
  ['jpg', '이미지로 변환'], ['ocr', '글자 인식(OCR)']
];
const pdfFile = (bytes, name) => new File([bytes], name, { type: 'application/pdf' });
function offerNext(files, from) {
  const box = document.getElementById('resultNext');
  const targets = NEXT_TARGETS.filter(([tab]) => tab !== from && (tab !== 'editor' || files.length === 1));
  if (!files.length) return;
  const label = document.createElement('span'); label.textContent = '이어서 작업:';
  box.replaceChildren(label, ...targets.map(([tab, text]) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn--secondary'; button.dataset.next = tab;
    button.textContent = `${text} →`; button.onclick = () => sendTo(tab, files); return button;
  }));
  box.hidden = false;
}
function sendTo(tab, files) {
  document.querySelector(`.tab-button[data-tab="${tab}"]`).click();
  if (tab === 'editor') window.workbenchEditor?.open(files[0]);
  else setFiles(tab, files, true);
  document.querySelector(`[data-panel="${tab}"]`).scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.workbench = { sendTo, offerNext, pdfFile };

function downloadBlob(blob, fileName) {
  checkCancelled();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function requireLibraries() {
  if (!window.PDFLib || !window.pdfjsLib || !window.JSZip) {
    throwUserError('필요한 PDF 라이브러리가 아직 로드되지 않았습니다. 인터넷 연결을 확인한 뒤 새로고침하세요.');
  }
}

function throwUserError(message) {
  throw new Error(message);
}

function isPdf(file) {
  return file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'pdf';
}

function normalizePdfName(name) {
  const clean = name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'merged.pdf';
  return clean.toLowerCase().endsWith('.pdf') ? clean : `${clean}.pdf`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

async function runUnlock() {
  const files = [...state.unlock];
  if (!files.length) throwUserError('잠금을 해제할 PDF 파일을 선택하세요.');
  if (files.length > 1 && !window.JSZip) {
    throwUserError('ZIP 라이브러리가 로드되지 않았습니다. 새로고침 후 다시 시도하세요.');
  }
  const passwordInput = document.getElementById('unlockPassword');
  const password = passwordInput.value;
  passwordInput.value = '';
  await withBusy('PDF 잠금을 해제하는 중...', async update => {
    const zip = files.length > 1 ? new JSZip() : null;
    const usedNames = new Set();
    const failures = [];
    const outputs = [];
    let saved = 0;
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      update((i / files.length) * 100, `${i + 1}/${files.length} · ${file.name} 잠금 해제 중`);
      try {
        const bytes = await unlockPdf(file, password);
        const name = uniquePdfName(`${baseName(file.name)}_unlocked.pdf`, usedNames);
        outputs.push(pdfFile(bytes, name));
        if (zip) zip.file(name, bytes);
        else downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
        saved += 1;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        failures.push(`${file.name}: ${error.message || String(error)}`);
      }
      update(((i + 1) / files.length) * 100, `${i + 1}/${files.length} 파일 처리 완료`);
    }
    if (zip && saved) {
      if (failures.length) zip.file('잠금해제_실패목록.txt', failures.join('\n'));
      update(100, 'ZIP 파일을 만드는 중...');
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `unlocked_pdfs_${Date.now()}.zip`);
    }
    update(100, `처리 완료 · 성공 ${saved}개 / 실패 ${failures.length}개`);
    showResult(
      saved ? 'PDF 잠금 해제 완료' : 'PDF 잠금 해제 실패',
      `${files.length}개 중 ${saved}개 저장 완료${zip && saved ? ' (ZIP)' : ''}.` +
        (failures.length ? `\n실패 ${failures.length}개:\n${failures.join('\n')}` : ''),
      !saved
    );
    if (saved) offerNext(outputs, 'unlock');
  });
}

async function unlockPdf(file, password) {
  const data = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const worker = new Worker('unlock-worker.js');
    const finish = (error, result) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve(result);
    };
    const signal = taskController?.signal;
    const onAbort = () => { clearTimeout(timer); worker.terminate(); reject(signal.reason); };
    const timer = setTimeout(() => finish('처리 시간이 초과되었습니다. 더 작은 PDF로 다시 시도하세요.'), 180000);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = ({ data: result }) => finish(result.error, result.bytes);
    worker.onerror = event => {
      event.preventDefault();
      finish('잠금 해제 도구를 실행하지 못했습니다. 새로고침 후 다시 시도하세요.');
    };
    worker.postMessage({ data, password }, [data]);
  });
}
