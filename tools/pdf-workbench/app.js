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
  split: [],
  jpg: [],
  compress: []
};

if (!window.PDFLib || !window.pdfjsLib || !window.JSZip) {
  els.cdnError.hidden = false;
}

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

document.querySelectorAll('.tab-button').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab-button').forEach(tab => tab.classList.remove('is-active'));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('is-active'));
    button.classList.add('is-active');
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
setupDrop('split', 'splitInput', false);
setupDrop('jpg', 'jpgInput', true);
setupDrop('compress', 'compressInput', true);

document.getElementById('jpgQuality').addEventListener('input', event => {
  document.getElementById('jpgQualityValue').textContent = `${event.target.value}%`;
});

document.getElementById('compressQuality').addEventListener('input', event => {
  document.getElementById('compressQualityValue').textContent = `${event.target.value}%`;
});

document.getElementById('mergeRun').addEventListener('click', () => handle(runMerge));
document.getElementById('splitRun').addEventListener('click', () => handle(runSplit));
document.getElementById('jpgRun').addEventListener('click', () => handle(runJpg));
document.getElementById('compressRun').addEventListener('click', () => handle(runCompress));

function setupDrop(type, inputId, multiple) {
  const zone = document.querySelector(`[data-drop="${type}"]`);
  const input = document.getElementById(inputId);

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
    const files = Array.from(event.dataTransfer.files || []).filter(file => isPdf(file));
    setFiles(type, files, multiple);
  });
}

function setFiles(type, files, multiple) {
  const pdfs = files.filter(file => isPdf(file));
  state[type] = multiple ? pdfs : pdfs.slice(0, 1);
  renderFileList(type);
  hideResult();
}

function renderFileList(type) {
  const list = document.getElementById(`${type}List`);
  const files = state[type];
  list.innerHTML = '';
  files.forEach((file, index) => {
    const li = document.createElement('li');
    li.innerHTML = `<b>${index + 1}. ${escapeHtml(file.name)}</b><span>${formatBytes(file.size)}</span>`;
    list.appendChild(li);
  });
}

async function handle(task) {
  try {
    await task();
  } catch (error) {
    showResult('처리 실패', error.message || String(error), true);
  }
}

async function runMerge() {
  requireLibraries();
  const files = state.merge;
  if (files.length < 2) throwUserError('PDF 파일을 2개 이상 선택하세요.');

  await withBusy('PDF를 합치는 중...', async update => {
    const mergedPdf = await PDFLib.PDFDocument.create();
    for (let i = 0; i < files.length; i += 1) {
      const sourcePdf = await PDFLib.PDFDocument.load(await files[i].arrayBuffer(), { ignoreEncryption: true });
      const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
      update(((i + 1) / files.length) * 100, `${i + 1}/${files.length} 파일 처리 완료`);
    }
    const bytes = await mergedPdf.save({ useObjectStreams: true, addDefaultPage: false });
    const fileName = normalizePdfName(document.getElementById('mergeName').value || 'merged.pdf');
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), fileName);
    showResult('PDF 합치기 완료', `${files.length}개 PDF를 ${fileName}로 저장했습니다.`);
  });
}

async function runSplit() {
  requireLibraries();
  const file = state.split[0];
  if (!file) throwUserError('분리할 PDF 파일을 선택하세요.');

  await withBusy('PDF를 분리하는 중...', async update => {
    const sourcePdf = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    const pages = parsePageRange(document.getElementById('splitRange').value, sourcePdf.getPageCount());
    if (!pages.length) throwUserError('분리할 페이지 범위를 확인하세요.');

    const base = baseName(file.name);
    const makeSingleZip = document.getElementById('splitSingleZip').checked;

    if (!makeSingleZip && pages.length === 1) {
      const pdf = await PDFLib.PDFDocument.create();
      const [page] = await pdf.copyPages(sourcePdf, [pages[0] - 1]);
      pdf.addPage(page);
      const bytes = await pdf.save({ useObjectStreams: true });
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${base}_p${pages[0]}.pdf`);
    } else {
      const zip = new JSZip();
      for (let i = 0; i < pages.length; i += 1) {
        const pdf = await PDFLib.PDFDocument.create();
        const [page] = await pdf.copyPages(sourcePdf, [pages[i] - 1]);
        pdf.addPage(page);
        const bytes = await pdf.save({ useObjectStreams: true });
        zip.file(`${base}_p${String(pages[i]).padStart(3, '0')}.pdf`, bytes);
        update(((i + 1) / pages.length) * 100, `${i + 1}/${pages.length} 페이지 분리 완료`);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${base}_split.zip`);
    }

    showResult('PDF 분리 완료', `${pages.length}개 페이지를 분리했습니다.`);
  });
}

async function runJpg() {
  requireLibraries();
  const files = state.jpg;
  if (!files.length) throwUserError('JPG로 변환할 PDF 파일을 선택하세요.');

  await withBusy('JPG로 변환하는 중...', async update => {
    const zip = new JSZip();
    const quality = Number(document.getElementById('jpgQuality').value) / 100;
    const scale = Number(document.getElementById('jpgScale').value);
    let done = 0;
    let total = 0;

    for (const file of files) {
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      total += pdf.numPages;
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
        const blob = await renderPageAsJpg(pdf, pageNo, scale, quality);
        zip.file(`${baseName(file.name)}_p${String(pageNo).padStart(3, '0')}.jpg`, blob);
        done += 1;
        update(total ? (done / total) * 100 : 5, `${done}개 페이지 변환 완료`);
      }
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `pdf_to_jpg_${Date.now()}.zip`);
    showResult('JPG 변환 완료', `${done}개 페이지를 JPG 이미지로 저장했습니다.`);
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

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      totalInput += file.size;
      const bytes = mode === 'raster'
        ? await rasterCompressPdf(file, quality, scale, message => {
            update(((i + message.progress) / files.length) * 100, message.label);
          })
        : await optimizePdf(file);
      totalOutput += bytes.length;
      const name = `${baseName(file.name)}_compressed.pdf`;
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
  });
}

async function optimizePdf(file) {
  const pdf = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  pdf.setProducer('LVMH Fashion Group PDF Workbench');
  pdf.setCreator('LVMH Fashion Group PDF Workbench');
  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
  return bytes.length < file.size ? bytes : new Uint8Array(await file.arrayBuffer());
}

async function rasterCompressPdf(file, quality, scale, onPage) {
  const source = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pdf = await PDFLib.PDFDocument.create();
  for (let pageNo = 1; pageNo <= source.numPages; pageNo += 1) {
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
}

async function renderPageAsJpg(pdf, pageNo, scale, quality) {
  const page = await pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function parsePageRange(value, pageCount) {
  if (!value.trim()) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set();
  value.split(',').map(part => part.trim()).filter(Boolean).forEach(part => {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) return;
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    for (let page = Math.min(start, end); page <= Math.max(start, end); page += 1) {
      if (page >= 1 && page <= pageCount) pages.add(page);
    }
  });
  return Array.from(pages).sort((a, b) => a - b);
}

async function withBusy(label, task) {
  setBusy(true);
  updateProgress(2, label);
  try {
    await task(updateProgress);
  } finally {
    setBusy(false);
  }
}

function updateProgress(percent, label) {
  els.progressSection.hidden = false;
  els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.progressLabel.textContent = label;
}

function setBusy(isBusy) {
  document.querySelectorAll('button').forEach(button => {
    button.disabled = isBusy;
  });
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
}

function downloadBlob(blob, fileName) {
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
