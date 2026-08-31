pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const COLUMNS = {
  fileName: { label: '파일명', width: 34 },
  documentType: { label: 'CREDIT NOTE', width: 16 },
  date: { label: 'Date', width: 13 },
  docNo: { label: 'Doc. No.', width: 14 },
  deliveryNote: { label: 'Delivery Note', width: 16 },
  orderNo: { label: 'Order no.', width: 14 },
  customerReference: { label: 'Customer reference', width: 22 },
  sku: { label: 'Item REF. (SKU)', width: 20 },
  description: { label: 'DESCRIPTION', width: 46 },
  qty: { label: 'QTY', width: 8 },
  unitPrice: { label: 'UNIT PRICE', width: 14 },
  netAmount: { label: 'NET AMOUNT', width: 15 },
};
const DEFAULT_COLUMNS = Object.keys(COLUMNS);
const STATE = { rows: [], warnings: [], errors: [], columnOrder: [...DEFAULT_COLUMNS], fileCount: 0 };

document.addEventListener('DOMContentLoaded', () => {
  renderColumnSettings(DEFAULT_COLUMNS);
  setupInputs();
  byId('btnDefault').addEventListener('click', () => { STATE.columnOrder = [...DEFAULT_COLUMNS]; renderColumnSettings(DEFAULT_COLUMNS); refreshTable(); });
  byId('btnAll').addEventListener('click', () => { renderColumnSettings(STATE.columnOrder); refreshTable(); });
  byId('btnExcel').addEventListener('click', exportExcel);
  byId('btnReset').addEventListener('click', resetApp);
  byId('btnCopyError').addEventListener('click', copyErrorReport);
  byId('btnDownloadError').addEventListener('click', downloadErrorReport);
});

window.addEventListener('error', event => recordError('화면 실행 오류', '', event.error || event.message));
window.addEventListener('unhandledrejection', event => recordError('비동기 처리 오류', '', event.reason));

function selectedColumns() { return STATE.columnOrder.filter(key => document.querySelector(`[data-column="${key}"] input`).checked); }
function renderColumnSettings(selectedKeys) {
  const selected = new Set(selectedKeys), list = byId('columnList');
  list.innerHTML = STATE.columnOrder.map((key, index) => `<div class="column-item" data-column="${key}"><span class="order">${index + 1}</span><label><input type="checkbox" ${selected.has(key) ? 'checked' : ''}><span>${COLUMNS[key].label}</span></label><em>${selected.has(key) ? '포함' : '제외'}</em><span class="move"><button data-dir="-1" ${index === 0 ? 'disabled' : ''}>↑</button><button data-dir="1" ${index === STATE.columnOrder.length - 1 ? 'disabled' : ''}>↓</button></span></div>`).join('');
  list.querySelectorAll('input').forEach(input => input.addEventListener('change', () => { if (!selectedColumns().length) input.checked = true; input.closest('.column-item').querySelector('em').textContent = input.checked ? '포함' : '제외'; updateColumnSummary(); refreshTable(); }));
  list.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('click', () => { const key = button.closest('.column-item').dataset.column, from = STATE.columnOrder.indexOf(key), to = from + Number(button.dataset.dir); if (to < 0 || to >= STATE.columnOrder.length) return; const checked = selectedColumns(); [STATE.columnOrder[from], STATE.columnOrder[to]] = [STATE.columnOrder[to], STATE.columnOrder[from]]; renderColumnSettings(checked); refreshTable(); }));
  updateColumnSummary();
}
function updateColumnSummary() { byId('columnSummary').textContent = `${selectedColumns().length}개 항목 선택`; }

function setupInputs() {
  const zone = byId('dropZone'), folder = byId('folderInput'), files = byId('fileInput');
  byId('btnFolder').addEventListener('click', e => { e.stopPropagation(); folder.click(); });
  byId('btnFiles').addEventListener('click', e => { e.stopPropagation(); files.click(); });
  zone.addEventListener('click', () => files.click());
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, e => { e.preventDefault(); zone.classList.add('active'); });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('active'); });
  zone.addEventListener('drop', async e => { e.preventDefault(); zone.classList.remove('active'); const list = await collectPdfFiles(e.dataTransfer); if (list.length) processFiles(list); });
  folder.addEventListener('change', () => { const list = [...folder.files].filter(isPdf); if (list.length) processFiles(list); folder.value = ''; });
  files.addEventListener('change', () => { const list = [...files.files].filter(isPdf); if (list.length) processFiles(list); files.value = ''; });
}
const isPdf = file => file.name.toLowerCase().endsWith('.pdf');
async function filesFromEntry(entry) { if (entry.isFile) return new Promise((resolve, reject) => entry.file(resolve, reject)); if (!entry.isDirectory) return []; const reader = entry.createReader(), found = []; while (true) { const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); if (!batch.length) break; for (const child of batch) { const value = await filesFromEntry(child); found.push(...(Array.isArray(value) ? value : [value])); } } return found; }
async function collectPdfFiles(dt) { const found = []; if (dt.items && dt.items.length) { for (const item of dt.items) { if (item.kind !== 'file') continue; const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; if (entry) { const value = await filesFromEntry(entry); found.push(...(Array.isArray(value) ? value : [value])); } else { const file = item.getAsFile(); if (file) found.push(file); } } } else found.push(...dt.files); return found.filter(isPdf); }

async function processFiles(files) {
  STATE.rows = []; STATE.warnings = []; STATE.errors = []; STATE.fileCount = files.length;
  show('progress', true); show('summary', false); show('actions', false); show('results', false); show('diagnostics', false);
  byId('dropZone').classList.add('loading');
  for (let i = 0; i < files.length; i++) {
    setProgress(i, files.length, `처리 중 (${i + 1}/${files.length}): ${files[i].name}`);
    try {
      const text = await parsePdf(files[i]);
      const { rows, warnings } = extractCreditNote(text, files[i].name);
      STATE.rows.push(...rows);
      STATE.warnings.push(...warnings);
    } catch (error) {
      STATE.warnings.push(`${files[i].name}: PDF 처리 오류 - ${error.message}`);
      recordError('PDF 처리 오류', files[i].name, error);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  setProgress(files.length, files.length, `완료: ${files.length}개 PDF 처리됨`);
  refreshTable(); renderSummary(); renderWarnings(); renderDiagnostics();
  show('summary', true); show('actions', true); show('results', true);
  byId('dropZone').classList.remove('loading');
  setTimeout(() => show('progress', false), 1200);
}

async function parsePdf(file) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let fullText = '';
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo), content = await page.getTextContent(), lineMap = new Map();
    for (const item of content.items) {
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y).push({ x: item.transform[4], str: item.str });
    }
    fullText += [...lineMap.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => items.sort((a, b) => a.x - b.x).map(item => item.str).join(' ')).join('\n') + '\n';
  }
  return normalize(fullText);
}

function extractCreditNote(text, fileName) {
  const rows = [], warnings = [], header = extractHeader(text);
  if (!/CREDIT NOTE/i.test(text)) warnings.push(`${fileName}: CREDIT NOTE 문구를 찾을 수 없음`);
  if (!header.docNo) warnings.push(`${fileName}: Doc. No. 값을 찾을 수 없음`);
  if (!header.deliveryNote) warnings.push(`${fileName}: Delivery Note 값을 찾을 수 없음`);

  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  let descParts = [], inItem = false;
  for (const line of lines) {
    const itemRow = line.match(/^([A-Z0-9]{8,})\s+(\d+)\s+([\d.]+)\s+[\d.]+\s+([\d.]+)$/);
    if (itemRow) {
      rows.push({ fileName, ...header, sku: itemRow[1], description: cleanDescription(descParts), qty: itemRow[2], unitPrice: itemRow[3], netAmount: itemRow[4] });
      continue;
    }
    if (/^[A-Z0-9]{8,}\s+[A-Z0-9]/.test(line) && !/^(ITEM|REF|HS CODE)/i.test(line)) {
      descParts = [line.replace(/^[A-Z0-9]{8,}\s+/, '')];
      inItem = true;
      continue;
    }
    if (inItem && /^HS CODE\s*:/i.test(line)) {
      inItem = false;
      continue;
    }
    if (inItem && !/^(Main Composant|ITEM REF|DESCRIPTION|QTY|UNIT PRICE|NET UNIT PRICE|NET AMOUNT)/i.test(line)) {
      descParts.push(line);
    }
  }
  if (!rows.length) warnings.push(`${fileName}: 품목 행을 찾을 수 없음`);
  return { rows, warnings };
}

function extractHeader(text) {
  const dateDoc = text.match(/(\d{2}\/\d{2}\/\d{4})\s+([A-Z0-9]{6,})\s+\d{2}\/\d{2}\/\d{4}/);
  const delivery = text.match(/Delivery Note\s*\/\s*BL\s*N[°o]?\s*([A-Z0-9]+)/i);
  const order = text.match(/Order no\.\s*\/\s*N[°o]?\s*Cde\s*:\s*([A-Z0-9]+)/i);
  const customer = text.match(/Customer reference\s*\/\s*R[ée]f\.\s*client\s*:\s*([^\n]+)/i);
  return {
    documentType: 'CREDIT NOTE',
    date: dateDoc ? dateDoc[1] : '',
    docNo: dateDoc ? dateDoc[2] : '',
    deliveryNote: delivery ? delivery[1] : '',
    orderNo: order ? order[1] : '',
    customerReference: customer ? customer[1].trim() : '',
  };
}

function cleanDescription(parts) { return parts.join(' ').replace(/\s+/g, ' ').replace(/\s+Made in\s+/i, ' / Made in ').trim(); }
function normalize(text) { return text.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'); }
function refreshTable() { const cols = selectedColumns(); byId('resultsHead').innerHTML = cols.map(key => `<th>${esc(COLUMNS[key].label)}</th>`).join(''); byId('resultsBody').innerHTML = STATE.rows.map(row => `<tr>${cols.map(key => `<td>${esc(row[key])}</td>`).join('')}</tr>`).join(''); }
function renderSummary() { byId('statFiles').textContent = STATE.fileCount; byId('statRows').textContent = STATE.rows.length; byId('statWarnings').textContent = STATE.warnings.length; }
function renderWarnings() { const box = byId('warnings'); box.hidden = !STATE.warnings.length; byId('warningCount').textContent = STATE.warnings.length; byId('warningList').innerHTML = STATE.warnings.map(w => `<li>${esc(w)}</li>`).join(''); }
function recordError(type, fileName, error) { STATE.errors.push({ time: new Date().toISOString(), type, fileName, message: (error && error.message) || String(error || '알 수 없는 오류'), stack: (error && error.stack) || '' }); }
function buildErrorReport() { return [`LVMH Fashion Group 업무 자동화 도구 오류 보고서`, `도구: CELINE 크레딧 노트 정리`, `생성 시각: ${new Date().toISOString()}`, `브라우저: ${navigator.userAgent}`, `처리 파일 수: ${STATE.fileCount}`, '', ...STATE.errors.flatMap((e, i) => [`[오류 ${i + 1}]`, `발생 시각: ${e.time}`, `유형: ${e.type}`, `파일명: ${e.fileName || '(없음)'}`, `메시지: ${e.message}`, e.stack ? `상세:\n${e.stack}` : '', ''])].join('\n'); }
function renderDiagnostics() { const box = byId('diagnostics'); box.hidden = !STATE.errors.length; if (STATE.errors.length) byId('diagnosticText').value = buildErrorReport(); }
async function copyErrorReport() { try { await navigator.clipboard.writeText(buildErrorReport()); byId('btnCopyError').textContent = '복사 완료 ✓'; } catch (error) { byId('diagnosticText').select(); document.execCommand('copy'); } }
function downloadErrorReport() { const blob = new Blob([buildErrorReport()], { type: 'text/plain;charset=utf-8' }), link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `CELINE_CN_오류보고서_${Date.now()}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
function exportExcel() { if (!STATE.rows.length) return; const cols = selectedColumns(), data = [cols.map(key => COLUMNS[key].label), ...STATE.rows.map(row => cols.map(key => ({ t: 's', v: String(row[key] == null ? '' : row[key]) })))], ws = XLSX.utils.aoa_to_sheet(data); ws['!cols'] = cols.map(key => ({ wch: COLUMNS[key].width })); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'CELINE Credit Note'); XLSX.writeFile(wb, `CELINE_Credit_Note_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.xlsx`); }
function setProgress(current, total, label) { byId('progressBar').style.width = `${total ? current / total * 100 : 0}%`; byId('progressText').textContent = label; }
function resetApp() { STATE.rows = []; STATE.warnings = []; STATE.errors = []; STATE.fileCount = 0; byId('resultsHead').innerHTML = ''; byId('resultsBody').innerHTML = ''; ['progress','summary','actions','results','warnings','diagnostics'].forEach(id => show(id, false)); }
function show(id, visible) { byId(id).hidden = !visible; }
function byId(id) { return document.getElementById(id); }
function esc(value) { return String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
