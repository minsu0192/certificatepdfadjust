import PostalMime from 'https://cdn.jsdelivr.net/npm/postal-mime@3.0.0/+esm';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const COLUMNS = {
  fileName: { label: '파일명', width: 38 }, subject: { label: '메일 제목', width: 46 }, mailDate: { label: '메일 발송일', width: 20 },
  hawb: { label: 'HAWB', width: 16 }, mawb: { label: 'MAWB', width: 18 }, org: { label: 'ORG', width: 10 }, dest: { label: 'DEST', width: 10 },
  shipper: { label: 'SHPR', width: 24 }, consignee: { label: 'CNEE', width: 28 }, incoterms: { label: 'INCOTERMS', width: 12 },
  flight: { label: '항공편', width: 12 }, departureAirport: { label: '출발 공항', width: 12 }, departureDateTime: { label: '출발 예정 일시', width: 22 },
  arrivalAirport: { label: '도착 공항', width: 12 }, arrivalDateTime: { label: '도착 예정 일시', width: 22 }, eta: { label: 'ETA', width: 14 },
  invoiceNo: { label: 'Invoice No', width: 16 }, srn: { label: 'SRN', width: 60 }, pon: { label: 'PON', width: 60 },
};
const INVOICE_COLUMNS = ['invoiceNo', 'srn', 'pon'];
const DEFAULT_COLUMNS = Object.keys(COLUMNS).filter(key => !INVOICE_COLUMNS.includes(key));
const STATE = { rows: [], warnings: [], errors: [], columnOrder: Object.keys(COLUMNS), fileCount: 0 };

document.addEventListener('DOMContentLoaded', () => {
  renderColumnSettings(DEFAULT_COLUMNS); setupInputs();
  document.getElementById('btnDefault').addEventListener('click', () => { STATE.columnOrder = Object.keys(COLUMNS); renderColumnSettings(DEFAULT_COLUMNS); document.getElementById('includeInvoice').checked = false; refreshTable(); });
  document.getElementById('btnAll').addEventListener('click', () => { renderColumnSettings(STATE.columnOrder); refreshTable(); });
  document.getElementById('btnExcel').addEventListener('click', exportExcel);
  document.getElementById('btnReset').addEventListener('click', resetApp);
  document.getElementById('btnCopyError').addEventListener('click', copyErrorReport);
  document.getElementById('btnDownloadError').addEventListener('click', downloadErrorReport);
  document.getElementById('includeInvoice').addEventListener('change', syncInvoiceColumns);
});

window.addEventListener('error', event => recordError('화면 실행 오류', '', event.error || event.message));
window.addEventListener('unhandledrejection', event => recordError('비동기 처리 오류', '', event.reason));

function selectedColumns() { return STATE.columnOrder.filter(key => document.querySelector(`[data-column="${key}"] input`).checked); }
function renderColumnSettings(selectedKeys) {
  const selected = new Set(selectedKeys), list = document.getElementById('columnList');
  list.innerHTML = STATE.columnOrder.map((key, index) => `<div class="column-item" data-column="${key}"><span class="order">${index + 1}</span><label><input type="checkbox" ${selected.has(key) ? 'checked' : ''}><span>${COLUMNS[key].label}</span></label><em>${selected.has(key) ? '포함' : '제외'}</em><span class="move"><button data-dir="-1" ${index === 0 ? 'disabled' : ''}>↑</button><button data-dir="1" ${index === STATE.columnOrder.length - 1 ? 'disabled' : ''}>↓</button></span></div>`).join('');
  list.querySelectorAll('input').forEach(input => input.addEventListener('change', () => { if (!selectedColumns().length) input.checked = true; input.closest('.column-item').querySelector('em').textContent = input.checked ? '포함' : '제외'; updateColumnSummary(); refreshTable(); }));
  list.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('click', () => { const key = button.closest('.column-item').dataset.column, from = STATE.columnOrder.indexOf(key), to = from + Number(button.dataset.dir); if (to < 0 || to >= STATE.columnOrder.length) return; const checked = selectedColumns(); [STATE.columnOrder[from], STATE.columnOrder[to]] = [STATE.columnOrder[to], STATE.columnOrder[from]]; renderColumnSettings(checked); refreshTable(); }));
  updateColumnSummary();
}
function updateColumnSummary() { document.getElementById('columnSummary').textContent = `${selectedColumns().length}개 항목 선택`; }
function syncInvoiceColumns() {
  const selected = new Set(selectedColumns());
  const includeInvoice = document.getElementById('includeInvoice').checked;
  INVOICE_COLUMNS.forEach(key => includeInvoice ? selected.add(key) : selected.delete(key));
  renderColumnSettings([...selected]);
  refreshTable();
}

function setupInputs() {
  const zone = document.getElementById('dropZone'), folder = document.getElementById('folderInput'), files = document.getElementById('fileInput');
  document.getElementById('btnFolder').addEventListener('click', e => { e.stopPropagation(); folder.click(); }); document.getElementById('btnFiles').addEventListener('click', e => { e.stopPropagation(); files.click(); }); zone.addEventListener('click', () => files.click());
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, e => { e.preventDefault(); zone.classList.add('active'); });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('active'); });
  zone.addEventListener('drop', async e => { e.preventDefault(); zone.classList.remove('active'); const list = await collectEmlFiles(e.dataTransfer); if (list.length) processFiles(list); });
  folder.addEventListener('change', () => { const list = [...folder.files].filter(isEml); if (list.length) processFiles(list); folder.value = ''; });
  files.addEventListener('change', () => { const list = [...files.files].filter(isEml); if (list.length) processFiles(list); files.value = ''; });
}
const isEml = file => file.name.toLowerCase().endsWith('.eml');
async function filesFromEntry(entry) { if (entry.isFile) return new Promise((resolve, reject) => entry.file(resolve, reject)); if (!entry.isDirectory) return []; const reader = entry.createReader(), found = []; while (true) { const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); if (!batch.length) break; for (const child of batch) { const value = await filesFromEntry(child); found.push(...(Array.isArray(value) ? value : [value])); } } return found; }
async function collectEmlFiles(dt) { const found = []; if (dt.items && dt.items.length) { for (const item of dt.items) { if (item.kind !== 'file') continue; const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; if (entry) { const value = await filesFromEntry(entry); found.push(...(Array.isArray(value) ? value : [value])); } else { const file = item.getAsFile(); if (file) found.push(file); } } } else found.push(...dt.files); return found.filter(isEml); }

async function processFiles(files) {
  const includeInvoice = document.getElementById('includeInvoice').checked;
  STATE.rows = []; STATE.warnings = []; STATE.errors = []; STATE.fileCount = files.length; show('progress', true); show('summary', false); show('actions', false); show('results', false); show('diagnostics', false); document.getElementById('dropZone').classList.add('loading');
  for (let i = 0; i < files.length; i++) {
    setProgress(i, files.length, `처리 중 (${i + 1}/${files.length}): ${files[i].name}`);
    try { const email = await PostalMime.parse(await files[i].arrayBuffer(), { maxNestingDepth: 50, maxHeadersSize: 1048576, maxRfc822NestingDepth: 0 }); const row = extractEmail(email, files[i].name); if (includeInvoice) Object.assign(row, await extractInvoiceAttachment(email, files[i].name)); STATE.rows.push(row); const required = includeInvoice ? ['hawb','mawb','org','dest','invoiceNo','srn','pon'] : ['hawb','mawb','org','dest']; const missing = required.filter(key => !row[key]).map(key => COLUMNS[key].label); if (missing.length) STATE.warnings.push(`${files[i].name}: ${missing.join(', ')} 값을 찾을 수 없음`); }
    catch (error) { STATE.warnings.push(`${files[i].name}: 메일 파싱 오류 — ${error.message}`); recordError('EML 파싱 오류', files[i].name, error); }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  setProgress(files.length, files.length, `완료: ${files.length}개 메일 처리됨`); refreshTable(); renderSummary(); renderWarnings(); renderDiagnostics(); show('summary', true); show('actions', true); show('results', true); document.getElementById('dropZone').classList.remove('loading'); setTimeout(() => show('progress', false), 1200);
}

function extractEmail(email, fileName) {
  const text = normalizeBody(email.text || htmlToText(email.html || ''));
  const field = label => { const m = text.match(new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+?)\\s*$`, 'im')); return m ? m[1].trim() : ''; };
  const schedule = extractSchedule(text), subject = email.subject || '', etaMatch = subject.match(/\bETA\s+(20\d{2}[-/.]\d{2}[-/.]\d{2})/i);
  return { fileName, subject, mailDate: formatMailDate(email.date), hawb: field('HAWB'), mawb: field('MAWB'), org: field('ORG'), dest: field('DEST'), shipper: field('SHPR'), consignee: field('CNEE'), incoterms: field('INCOTERMS'), ...schedule, eta: etaMatch ? etaMatch[1].replace(/[/.]/g, '-') : schedule.arrivalDateTime.slice(0, 11).trim(), invoiceNo: '', srn: '', pon: '' };
}
async function extractInvoiceAttachment(email, fileName) {
  const blank = { invoiceNo: '', srn: '', pon: '' };
  const attachments = email.attachments || [];
  const invoice = attachments.find(part => isInvoicePdf(part));
  if (!invoice) {
    STATE.warnings.push(`${fileName}: Invoice PDF 첨부파일을 찾을 수 없음`);
    return blank;
  }
  try {
    const text = await parsePdfAttachment(invoice.content);
    return extractInvoiceFields(text);
  } catch (error) {
    recordError('첨부 Invoice PDF 처리 오류', invoice.filename || fileName, error);
    STATE.warnings.push(`${fileName}: Invoice PDF 처리 오류 — ${error.message}`);
    return blank;
  }
}
function isInvoicePdf(part) {
  const name = (part.filename || '').toLowerCase();
  const type = (part.mimeType || part.contentType || '').toLowerCase();
  return name.includes('invoice') && (name.endsWith('.pdf') || type.includes('pdf'));
}
async function parsePdfAttachment(content) {
  const data = content instanceof Uint8Array ? content : new Uint8Array(content);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let fullText = '';
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo), pageContent = await page.getTextContent(), lineMap = new Map();
    for (const item of pageContent.items) {
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y).push({ x: item.transform[4], str: item.str });
    }
    fullText += [...lineMap.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => items.sort((a, b) => a.x - b.x).map(item => item.str).join(' ')).join('\n') + '\n';
  }
  return normalizeBody(fullText);
}
function extractInvoiceFields(text) {
  const invoiceMatch = text.match(/\bINVOICE\s+([A-Z0-9-]+)/i);
  return {
    invoiceNo: invoiceMatch ? invoiceMatch[1].trim() : '',
    srn: extractReferenceValue(text, 'SRN', ['CRF', 'PON', 'CIN', '품명']),
    pon: extractReferenceValue(text, 'PON', ['CIN', '품명', '서비스 레벨']),
  };
}
function extractReferenceValue(text, label, stopLabels) {
  const stop = stopLabels.map(value => `${value}\\s*:`).join('|');
  const pattern = new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=\\s*(?:${stop})|\\n\\s*품명|\\n\\s*서비스\\s*레벨|$)`, 'i');
  const match = text.match(pattern);
  return match ? match[1].replace(/\s+/g, ' ').replace(/,$/, '').trim() : '';
}
function normalizeBody(text) { return text.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'); }
function htmlToText(html) { const doc = new DOMParser().parseFromString(html, 'text/html'); doc.querySelectorAll('br').forEach(node => node.replaceWith('\n')); doc.querySelectorAll('p,div,tr').forEach(node => node.append('\n')); return doc.body.textContent || ''; }
function extractSchedule(text) { const date = '(\\d{1,2}-[A-Za-z]{3}-\\d{2,4}\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)', m = text.match(new RegExp(`\\b([A-Z0-9]{2,10})\\s*\\|\\s*([A-Z]{3})\\s*[|lI]\\s*${date}\\s*\\|\\s*([A-Z]{3})\\s*[|lI]\\s*${date}`, 'i')); return m ? { flight: m[1].toUpperCase(), departureAirport: m[2].toUpperCase(), departureDateTime: m[3], arrivalAirport: m[4].toUpperCase(), arrivalDateTime: m[5] } : { flight: '', departureAirport: '', departureDateTime: '', arrivalAirport: '', arrivalDateTime: '' }; }
function formatMailDate(value) { if (!value) return ''; const d = new Date(value); if (Number.isNaN(d.getTime())) return value; const parts = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d), get = type => { const part = parts.find(p => p.type === type); return part ? part.value : ''; }; return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`; }
function refreshTable() { if (!STATE.rows.length) return; const cols = selectedColumns(); document.getElementById('resultsHead').innerHTML = cols.map(key => `<th>${esc(COLUMNS[key].label)}</th>`).join(''); document.getElementById('resultsBody').innerHTML = STATE.rows.map(row => `<tr>${cols.map(key => `<td>${esc(row[key])}</td>`).join('')}</tr>`).join(''); }
function renderSummary() { document.getElementById('statFiles').textContent = STATE.fileCount; document.getElementById('statSuccess').textContent = STATE.rows.length; document.getElementById('statWarnings').textContent = STATE.warnings.length; }
function renderWarnings() { const box = document.getElementById('warnings'); box.hidden = !STATE.warnings.length; document.getElementById('warningCount').textContent = STATE.warnings.length; document.getElementById('warningList').innerHTML = STATE.warnings.map(w => `<li>${esc(w)}</li>`).join(''); }
function recordError(type, fileName, error) { const message = (error && error.message) || String(error || '알 수 없는 오류'); STATE.errors.push({ time: new Date().toISOString(), type, fileName, message, stack: (error && error.stack) || '' }); }
function buildErrorReport() { return [`LVMH Fashion Group 업무 자동화 도구 오류 보고서`, `도구: DHL Pre-Alert 메일 본문 정리`, `생성 시각: ${new Date().toISOString()}`, `브라우저: ${navigator.userAgent}`, `처리 파일 수: ${STATE.fileCount}`, '', ...STATE.errors.flatMap((e, i) => [`[오류 ${i + 1}]`, `발생 시각: ${e.time}`, `유형: ${e.type}`, `파일명: ${e.fileName || '(없음)'}`, `메시지: ${e.message}`, e.stack ? `상세:\n${e.stack}` : '', ''])].join('\n'); }
function renderDiagnostics() { const box = document.getElementById('diagnostics'); box.hidden = !STATE.errors.length; if (STATE.errors.length) document.getElementById('diagnosticText').value = buildErrorReport(); }
async function copyErrorReport() { const text = buildErrorReport(); try { await navigator.clipboard.writeText(text); document.getElementById('btnCopyError').textContent = '복사 완료 ✓'; } catch (error) { document.getElementById('diagnosticText').select(); document.execCommand('copy'); } }
function downloadErrorReport() { const blob = new Blob([buildErrorReport()], { type: 'text/plain;charset=utf-8' }), link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `DHL_오류보고서_${Date.now()}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
function exportExcel() { if (!STATE.rows.length) return; const cols = selectedColumns(), data = [cols.map(key => COLUMNS[key].label), ...STATE.rows.map(row => cols.map(key => ({ t: 's', v: String(row[key] == null ? '' : row[key]) })))], ws = XLSX.utils.aoa_to_sheet(data); ws['!cols'] = cols.map(key => ({ wch: COLUMNS[key].width })); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'DHL Pre-Alert'); const now = new Date(), stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`; XLSX.writeFile(wb, `DHL_PreAlert_메일정리_${stamp}.xlsx`); }
function setProgress(current, total, label) { document.getElementById('progressBar').style.width = `${total ? current / total * 100 : 0}%`; document.getElementById('progressText').textContent = label; }
function resetApp() { STATE.rows = []; STATE.warnings = []; STATE.errors = []; STATE.fileCount = 0; document.getElementById('resultsHead').innerHTML = ''; document.getElementById('resultsBody').innerHTML = ''; ['progress','summary','actions','results','warnings','diagnostics'].forEach(id => show(id, false)); }
function show(id, visible) { document.getElementById(id).hidden = !visible; }
function esc(value) { return String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
