const CONFIG = {
  PDFJS_WORKER_URL: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  OCR_LANG: 'kor+eng',
  OCR_SCALE: 2,
};

const DOC_TYPES = {
  DHL_INVOICE: 'DHL Invoice',
  DHL_ETRADEBILL: 'DHL eTradebill',
  DHL_UNKNOWN: 'DHL Unknown',
  UNKNOWN: '미확인',
};

const STATE = {
  files: [],
  fileIndex: [],
  dhlChecks: [],
  activeTab: 'dhl',
  processing: false,
};

document.addEventListener('DOMContentLoaded', () => {
  if (!checkLibraries()) return;
  setupInputs();
  setupActions();
  setupTabs();
});

function checkLibraries() {
  const ok = typeof pdfjsLib !== 'undefined' && typeof XLSX !== 'undefined';
  if (!ok) {
    show('cdnError', true);
    return false;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = CONFIG.PDFJS_WORKER_URL;
  return true;
}

function setupInputs() {
  const zone = byId('dropZone');
  const folder = byId('folderInput');
  const files = byId('fileInput');

  byId('btnFolder').addEventListener('click', event => {
    event.stopPropagation();
    folder.click();
  });
  byId('btnFiles').addEventListener('click', event => {
    event.stopPropagation();
    files.click();
  });
  zone.addEventListener('click', () => files.click());

  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, event => {
      event.preventDefault();
      zone.classList.add('active');
    });
  }
  zone.addEventListener('dragleave', event => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('active');
  });
  zone.addEventListener('drop', async event => {
    event.preventDefault();
    zone.classList.remove('active');
    addFiles(await collectPdfFiles(event.dataTransfer));
  });
  folder.addEventListener('change', () => {
    addFiles([...folder.files].filter(isPdf));
    folder.value = '';
  });
  files.addEventListener('change', () => {
    addFiles([...files.files].filter(isPdf));
    files.value = '';
  });
}

function setupActions() {
  byId('btnClear').addEventListener('click', event => {
    event.stopPropagation();
    resetApp();
  });
  byId('btnStart').addEventListener('click', processFiles);
  byId('btnExcel').addEventListener('click', exportExcel);
  byId('btnReset').addEventListener('click', resetApp);
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      STATE.activeTab = tab.dataset.tab;
      setActiveTabButton(STATE.activeTab);
      renderResults();
    });
  });
}

function setActiveTabButton(tabName) {
  document.querySelectorAll('.tab').forEach(item => {
    item.classList.toggle('is-active', item.dataset.tab === tabName);
  });
}

function addFiles(files) {
  if (!files.length || STATE.processing) return;
  for (const file of files) STATE.files.push({ file, type: '', status: '대기' });
  renderFileList();
  show('filePanel', STATE.files.length > 0);
}

async function processFiles() {
  if (!STATE.files.length || STATE.processing) return;
  STATE.processing = true;
  STATE.fileIndex = [];
  STATE.dhlChecks = [];
  STATE.activeTab = 'dhl';
  setActiveTabButton('dhl');
  show('progress', true);
  show('summary', false);
  show('actions', false);
  show('results', false);
  byId('btnStart').disabled = true;

  const hashes = new Map();
  for (let i = 0; i < STATE.files.length; i++) {
    const item = STATE.files[i];
    try {
      setFileStatus(i, item.type || '', '해시 계산 중');
      setProgress(i, STATE.files.length, `해시 계산 중 (${i + 1}/${STATE.files.length}): ${item.file.name}`);
      const hash = await sha256(item.file);
      if (hashes.has(hash)) {
        const duplicateOf = hashes.get(hash);
        item.type = 'DUPLICATE';
        item.status = '중복 제외';
        STATE.fileIndex.push(fileIndexRow(item.file, hash, 'DUPLICATE', 0, '', duplicateOf, 'DUPLICATE'));
        STATE.dhlChecks.push(dhlCheckRow({ sourceFile: item.file.name, documentType: 'DUPLICATE', extraction: 'Duplicate', reason: `Duplicate of ${duplicateOf}`, status: 'DUPLICATE' }));
        renderFileList();
        continue;
      }
      hashes.set(hash, item.file.name);

      setFileStatus(i, '', '텍스트 추출 중');
      setProgress(i, STATE.files.length, `텍스트 추출 중 (${i + 1}/${STATE.files.length}): ${item.file.name}`);
      const parsed = await extractPdfText(item.file, message => {
        setProgress(i, STATE.files.length, `${message}: ${item.file.name}`);
      });
      const type = classifyDhlDocument(item.file.name, parsed.text);
      item.type = type;
      renderFileList();

      const result = parseDhlDocument(type, parsed.text, item.file.name, parsed.method);
      STATE.dhlChecks.push(...result.rows);
      item.status = result.status === 'OK' ? '완료' : '검토 필요';
      STATE.fileIndex.push(fileIndexRow(item.file, hash, type, parsed.pages, parsed.method, '', item.status));
      renderFileList();
    } catch (error) {
      item.status = '오류';
      STATE.fileIndex.push(fileIndexRow(item.file, '', item.type || DOC_TYPES.UNKNOWN, 0, '', '', 'ERROR'));
      STATE.dhlChecks.push(dhlCheckRow({ sourceFile: item.file.name, documentType: 'UNKNOWN', extraction: 'Review', reason: error.message || String(error), status: 'ERROR' }));
      renderFileList();
    }
    await tick();
  }

  setProgress(STATE.files.length, STATE.files.length, `완료: ${STATE.files.length}개 PDF 처리`);
  STATE.processing = false;
  byId('btnStart').disabled = false;
  renderSummary();
  renderResults();
  show('summary', true);
  show('actions', true);
  show('results', true);
}

async function extractPdfText(file, onStatus) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const pageTexts = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    pageTexts.push(textItemsToLines(content.items));
  }

  let text = normalizeText(pageTexts.join('\n---PAGE_BREAK---\n'));
  let method = 'PDF Text';
  if (shouldRunOcr(text) && typeof Tesseract !== 'undefined') {
    if (onStatus) onStatus('OCR 중');
    const ocrTexts = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: CONFIG.OCR_SCALE });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const response = await Tesseract.recognize(canvas, CONFIG.OCR_LANG, {
        logger: event => {
          if (event.status && onStatus) onStatus(`OCR 중 ${Math.round((event.progress || 0) * 100)}%`);
        },
      });
      ocrTexts.push(response.data.text || '');
      canvas.width = 0;
      canvas.height = 0;
      await tick();
    }
    const ocrText = normalizeText(ocrTexts.join('\n---PAGE_BREAK---\n'));
    if (ocrText.length > text.length) {
      text = ocrText;
      method = 'OCR';
    }
  }
  return { text, pages: pdf.numPages, method };
}

function textItemsToLines(items) {
  const lineMap = new Map();
  for (const item of items) {
    const y = Math.round(item.transform[5] / 3) * 3;
    if (!lineMap.has(y)) lineMap.set(y, []);
    lineMap.get(y).push({ x: item.transform[4], str: item.str });
  }
  return [...lineMap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, lineItems]) => lineItems.sort((a, b) => a.x - b.x).map(item => item.str).join(' '))
    .join('\n');
}

function shouldRunOcr(text) {
  const compact = text.replace(/\s/g, '');
  const cidCount = (text.match(/\(cid:\d+\)/g) || []).length;
  const brokenCount = (text.match(/[�□]/g) || []).length;
  const slashCodeCount = (text.match(/\/(?:i)?\d{1,3}/g) || []).length;
  return compact.length < 100 || cidCount > 10 || brokenCount > 20 || slashCodeCount > 80;
}

function classifyDhlDocument(fileName, text) {
  const source = `${fileName}\n${text}`;
  if (/전자\s*세금계산서|승인번호|eTradebill/i.test(source)) return DOC_TYPES.DHL_ETRADEBILL;
  if (/DHL/i.test(source) && (/SHIPMENT DETAILS/i.test(source) || /INVOICE\s*S\d+/i.test(source))) return DOC_TYPES.DHL_INVOICE;
  if (/DHL/i.test(source)) return DOC_TYPES.DHL_UNKNOWN;
  return DOC_TYPES.UNKNOWN;
}

function parseDhlDocument(type, text, fileName, method) {
  if (type === DOC_TYPES.DHL_INVOICE) return parseDhlInvoice(text, fileName, method);
  if (type === DOC_TYPES.DHL_ETRADEBILL) return parseDhlEtradebill(text, fileName, method);
  const reason = type === DOC_TYPES.DHL_UNKNOWN ? 'DHL document type could not be determined' : 'Not a DHL PDF';
  return {
    rows: [dhlCheckRow({ documentType: 'UNKNOWN', extraction: 'Review', reason, sourceFile: fileName, extractionMethod: method, status: 'CHECK' })],
    status: 'CHECK',
  };
}

function parseDhlInvoice(text, fileName, method) {
  const invoiceNumbers = unique([...text.matchAll(/\bINVOICE\s+(S\d+)\b/gi)].map(match => match[1].toUpperCase()));
  const targets = invoiceNumbers.length ? invoiceNumbers : [''];
  const rows = [];
  for (const invoiceNumber of targets) {
    const block = invoiceNumber ? dhlInvoiceBlock(text, invoiceNumber) : text;
    const invoiceLabel = invoiceNumber ? `INVOICE ${invoiceNumber}` : '';
    const invoiceDate = normalizeDate(firstMatch(block, [/INVOICE\s+DATE\s+([0-9]{1,2}-[A-Za-z]{3}-[0-9]{2,4})/i])) || extractDateNear(block, /Invoice\s*Date|Date/i) || firstDate(block);
    const shipmentNumber = firstMatch(block, [/SHIPMENT\s+(S\d+)/i, /Shipment\s*(?:Number|No\.?)\s*[:#]?\s*([A-Z0-9-]+)/i]);
    const houseBlNumber = extractHouseBlNumber(block);
    const subtotal = amountNear(block, /\bSUBTOTAL\b/i);
    const vat = amountNear(block, /\bVAT\b/i);
    const total = amountNear(block, /\bTOTAL\s+KRW\b/i);
    const reason = [
      !invoiceLabel ? 'Missing DHL invoice number' : '',
      !invoiceDate ? 'Missing invoice date' : '',
      subtotal == null ? 'Missing subtotal' : '',
      vat == null ? 'Missing VAT' : '',
      total == null ? 'Missing total' : '',
    ].filter(Boolean).join('; ');
    rows.push(dhlCheckRow({
      documentType: 'INVOICE',
      extraction: 'Included',
      invoiceNumber: invoiceLabel,
      invoiceDate,
      shipmentNumber,
      houseBlNumber,
      supplyAmount: subtotal,
      vat,
      settlementTotal: total,
      reason,
      sourceFile: fileName,
      extractionMethod: method,
      status: reason ? 'CHECK' : 'OK',
    }));
  }
  return { rows, status: rows.some(row => row.Status === 'CHECK') ? 'CHECK' : 'OK' };
}

function parseDhlEtradebill(text, fileName, method) {
  const issueNumber = firstMatch(text, [/발급번호\s*[:：]?\s*([A-Za-z0-9.-]+)/i, /Issue\s*(?:Number|No\.?)\s*[:#]?\s*([A-Za-z0-9.-]+)/i]);
  const approval = firstMatch(text, [/승인번호\s*[:：]?\s*([A-Za-z0-9-]{12,})/i, /Approval\s*(?:Number|No\.?)\s*[:#]?\s*([A-Za-z0-9-]{12,})/i]);
  const issueDate = extractDateNear(text, /작성일자|Issue\s*Date|Date/i) || firstDate(text);
  const amounts = extractEtradebillAmounts(text);
  const supplyAmount = amounts.supplyAmount;
  let vat = amounts.vat;
  const total = amounts.total;
  const extra = extractEtradebillExtraAmounts(text);
  if (extra.settlementTotal == null && supplyAmount != null && extra.reimbursedExpense != null) {
    extra.settlementTotal = supplyAmount + extra.reimbursedExpense;
  }
  const houseBlNumber = extractHouseBlNumber(text);
  const taxType = vat === 0 || /Zero\s*Rated|0\s*%/i.test(text) ? 'Zero Rated' : 'Taxable';
  if (vat == null && taxType === 'Zero Rated') vat = 0;
  const reason = [
    !issueNumber ? 'Missing issue number' : '',
    !approval ? 'Missing approval number' : '',
    !issueDate ? 'Missing issue date' : '',
    supplyAmount == null ? 'Missing supply amount' : '',
    vat == null ? 'Missing VAT' : '',
    total == null ? 'Missing total' : '',
    supplyAmount != null && vat != null && total != null && Math.abs((supplyAmount + vat) - total) > 1 ? 'Supply amount + VAT mismatch' : '',
  ].filter(Boolean).join('; ');
  return {
    rows: [dhlCheckRow({
      documentType: 'ETRADEBILL',
      extraction: 'Included',
      issueNumber,
      approvalNumber: approval,
      invoiceDate: issueDate,
      houseBlNumber,
      supplyAmount,
      vat,
      total,
      reimbursedExpense: extra.reimbursedExpense,
      settlementTotal: extra.settlementTotal,
      taxType,
      reason,
      sourceFile: fileName,
      extractionMethod: method,
      status: reason ? 'CHECK' : 'OK',
    })],
    status: reason ? 'CHECK' : 'OK',
  };
}

function dhlCheckRow(data) {
  return {
    'Vendor Name': 'DHL',
    'Document Type': data.documentType || '',
    'Invoice Number': data.invoiceNumber || '',
    날짜: data.invoiceDate || '',
    발급번호: data.issueNumber || '',
    승인번호: data.approvalNumber || '',
    'House B/L 번호': data.houseBlNumber || '',
    공급가액: valueOrBlank(data.supplyAmount),
    세액: valueOrBlank(data.vat),
    대납비용: valueOrBlank(data.reimbursedExpense),
    총정산금액: valueOrBlank(data.settlementTotal),
    합계금액: valueOrBlank(data.total),
    Reason: data.reason || '',
    'Source File': data.sourceFile || '',
    Status: data.status || 'OK',
  };
}

function fileIndexRow(file, hash, type, pages, method, duplicateOf, status) {
  return {
    File: file.name,
    'SHA-256': hash,
    'Document Type': type,
    Pages: pages || '',
    'Extraction Method': method,
    'Duplicate Of': duplicateOf,
    Status: status,
  };
}

function renderFileList() {
  byId('fileBody').innerHTML = STATE.files.map(item => `
    <tr>
      <td>${esc(item.file.name)}</td>
      <td>${formatBytes(item.file.size)}</td>
      <td>${esc(item.type || '-')}</td>
      <td><span class="pill ${statusClass(item.status)}">${esc(item.status)}</span></td>
    </tr>
  `).join('');
}

function renderSummary() {
  const stats = dhlStats();
  byId('statFiles').textContent = stats.total;
  byId('statInvoice').textContent = stats.invoice;
  byId('statEtradebill').textContent = stats.etradebill;
  byId('statUnknown').textContent = stats.unknown;
  byId('statDuplicate').textContent = stats.duplicate;
}

function renderResults() {
  const data = STATE.activeTab === 'files' ? STATE.fileIndex : sortedDhlChecks();
  const columns = getColumns(data, STATE.activeTab);
  byId('resultHead').innerHTML = `<tr>${columns.map(col => `<th>${esc(col)}</th>`).join('')}</tr>`;
  byId('resultBody').innerHTML = data.map(row => `<tr class="${row.Status === 'CHECK' ? 'row-check' : row.Status === 'ERROR' ? 'row-error' : row.Status === 'DUPLICATE' ? 'row-duplicate' : ''}">${columns.map(col => `<td>${esc(row[col])}</td>`).join('')}</tr>`).join('');
}

function exportExcel() {
  const wb = XLSX.utils.book_new();
  appendSheet(wb, 'DHL_Invoice_Check', sortedDhlChecks(), 'dhl');
  appendSheet(wb, 'File_Index', STATE.fileIndex, 'files');
  XLSX.writeFile(wb, `DHL_Invoice_Check_${timestamp()}.xlsx`);
}

function appendSheet(wb, name, rows, fallback) {
  const columns = getColumns(rows, fallback || name);
  const data = [columns, ...rows.map(row => columns.map(col => row[col] == null ? '' : row[col]))];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = columns.map(col => ({ wch: Math.max(12, Math.min(34, col.length + 6)) }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: columns.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, name);
}

function getColumns(rows, fallback) {
  const presets = {
    dhl: ['Vendor Name', 'Document Type', 'Invoice Number', '날짜', '발급번호', '승인번호', 'House B/L 번호', '공급가액', '세액', '대납비용', '총정산금액', '합계금액', 'Reason', 'Source File', 'Status'],
    DHL_Invoice_Check: ['Vendor Name', 'Document Type', 'Invoice Number', '날짜', '발급번호', '승인번호', 'House B/L 번호', '공급가액', '세액', '대납비용', '총정산금액', '합계금액', 'Reason', 'Source File', 'Status'],
    files: ['File', 'SHA-256', 'Document Type', 'Pages', 'Extraction Method', 'Duplicate Of', 'Status'],
    File_Index: ['File', 'SHA-256', 'Document Type', 'Pages', 'Extraction Method', 'Duplicate Of', 'Status'],
  };
  if (presets[fallback]) return presets[fallback];
  return rows.length ? Object.keys(rows[0]) : [];
}

function dhlStats() {
  return {
    total: STATE.dhlChecks.length,
    invoice: STATE.dhlChecks.filter(row => row['Document Type'] === 'INVOICE').length,
    etradebill: STATE.dhlChecks.filter(row => row['Document Type'] === 'ETRADEBILL').length,
    unknown: STATE.dhlChecks.filter(row => row['Document Type'] === 'UNKNOWN').length,
    duplicate: STATE.dhlChecks.filter(row => row['Document Type'] === 'DUPLICATE').length,
  };
}

function sortedDhlChecks() {
  const order = { INVOICE: 0, ETRADEBILL: 1, UNKNOWN: 2, DUPLICATE: 3 };
  return [...STATE.dhlChecks].sort((a, b) => {
    const aOrder = Object.prototype.hasOwnProperty.call(order, a['Document Type']) ? order[a['Document Type']] : 9;
    const bOrder = Object.prototype.hasOwnProperty.call(order, b['Document Type']) ? order[b['Document Type']] : 9;
    return aOrder - bOrder || String(a['Invoice Date'] || '').localeCompare(String(b['Invoice Date'] || ''));
  });
}

function parseAmount(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  const normalized = raw.replace(/[₩,\sA-Z가-힣]/gi, '').replace(/[()]/g, '');
  if (!normalized || normalized === '-' || Number.isNaN(Number(normalized))) return null;
  const amount = Number(normalized);
  return negative ? -Math.abs(amount) : amount;
}

function amountNear(text, labelRe) {
  const match = text.match(labelRe);
  if (!match) return null;
  const after = text.slice(match.index).split('\n').slice(0, 3).join(' ');
  const values = monetaryMatches(after);
  return values.length ? values[values.length - 1] : null;
}

function monetaryMatches(text) {
  return [...String(text || '').matchAll(/-?\(?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|-?\(?\d+\.\d{2}\)?/g)]
    .map(item => parseAmount(item[0]))
    .filter(value => value != null);
}

function dhlInvoiceBlock(text, invoiceNumber) {
  const pageRe = new RegExp(`INVOICE\\s+${escapeRegExp(invoiceNumber)}\\s+Page\\s+\\d+\\s+of\\s+\\d+`, 'gi');
  const allInvoiceRe = /\bINVOICE\s+S\d+\s+Page\s+\d+\s+of\s+\d+/gi;
  const pageMatches = [...text.matchAll(pageRe)];
  const allMatches = [...text.matchAll(allInvoiceRe)];
  if (!pageMatches.length) return blockAround(text, invoiceNumber, 5000);
  return pageMatches.map(match => {
    const next = allMatches.find(item => item.index > match.index);
    return text.slice(match.index, next ? next.index : text.length);
  }).join('\n');
}

function extractEtradebillAmounts(text) {
  const headerIndex = text.search(/공급가액\s+세액/);
  const headerScope = headerIndex >= 0 ? text.slice(headerIndex, headerIndex + 1800).replace(/\n/g, ' ') : text.replace(/\n/g, ' ');
  const firstDateInScope = headerScope.search(/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/);
  const amountScope = firstDateInScope >= 0 ? headerScope.slice(0, firstDateInScope) : headerScope.slice(0, 900);
  const headerAmounts = monetaryMatches(amountScope);
  let supplyAmount = headerAmounts.length ? headerAmounts[0] : null;
  let vat = headerAmounts.length > 1 ? headerAmounts[1] : null;

  if (supplyAmount == null && headerIndex >= 0) {
    const firstItemIndex = headerScope.search(/\b\d{2}\s+\d{2}\s+[A-Za-z가-힣]/);
    const preItemScope = firstItemIndex >= 0 ? headerScope.slice(0, firstItemIndex) : headerScope;
    const preItemAmounts = monetaryMatches(preItemScope);
    supplyAmount = preItemAmounts.length ? preItemAmounts[0] : null;
    vat = null;
  }

  if (supplyAmount == null) {
    const pairMatches = [...text.matchAll(/(\d{1,3}(?:,\d{3})+)\s+(\d{1,3}(?:,\d{3})+)/g)]
      .map(match => ({ index: match.index, first: parseAmount(match[1]), second: parseAmount(match[2]) }));
    const supplyPair = pairMatches.find(item => headerIndex < 0 || item.index > headerIndex);
    supplyAmount = supplyPair ? supplyPair.first : null;
    vat = supplyPair ? supplyPair.second : null;
  }

  const totalIndex = text.search(/합계금액/);
  const totals = monetaryMatches(text.slice(Math.max(0, totalIndex), totalIndex >= 0 ? totalIndex + 1200 : text.length));
  if (vat == null && supplyAmount != null && totals.includes(supplyAmount)) vat = 0;
  const expectedTotal = supplyAmount != null && vat != null ? supplyAmount + vat : null;
  let total = null;
  if (expectedTotal != null) total = totals.find(value => value === expectedTotal) || null;
  if (total == null && expectedTotal != null && text.includes(String(expectedTotal).replace(/\B(?=(\d{3})+(?!\d))/g, ','))) total = expectedTotal;
  if (total == null && vat === 0) total = supplyAmount;
  return {
    supplyAmount,
    vat,
    total,
  };
}

function extractEtradebillExtraAmounts(text) {
  const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
  const start = lines.findIndex(line => /부가금액|대납비용|총정산금액|B\/L\s*총금액/i.test(line));
  const scope = start >= 0 ? lines.slice(start, start + 22) : lines;
  const reimbursedLine = scope.find(line => /대납|Charges\s*Collect\s*Fee/i.test(line) && monetaryMatches(line).length);
  const reimbursedValues = reimbursedLine ? monetaryMatches(reimbursedLine) : [];
  const settlementLabelIndex = scope.findIndex(line => /총정산금액/i.test(line));
  const settlementValues = settlementLabelIndex >= 0 ? monetaryMatches(scope.slice(settlementLabelIndex).join(' ')) : [];
  const flatText = String(text || '').replace(/\s+/g, ' ');
  const wfAmount = parseAmount(firstMatch(flatText, [/W\/F\s*;?\s*(\d{1,3}(?:,\d{3})+)/i]));
  const totalAmount = parseAmount(firstMatch(flatText, [/총\s*합계\s*(\d{1,3}(?:,\d{3})+)/i, /총정산금액\s*(\d{1,3}(?:,\d{3})+)/i]));
  return {
    reimbursedExpense: reimbursedValues.length ? reimbursedValues[reimbursedValues.length - 1] : wfAmount,
    settlementTotal: settlementValues.length ? settlementValues[settlementValues.length - 1] : totalAmount,
  };
}

function extractHouseBlNumber(text) {
  const direct = firstMatch(text, [
    /\bNO\.?\s*([A-Z]{1,6}\d{4,}[A-Z0-9.-]*)/i,
    /House\s*B\/L\s*번호\s*[:：]?\s*([A-Z0-9][A-Z0-9.-]{4,})/i,
    /\bHAWB\s*[:：]?\s*([A-Z0-9][A-Z0-9.-]{4,})/i,
  ]);
  if (direct && !/번호$/i.test(direct)) return direct;
  const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
  const index = lines.findIndex(line => /House\s*B\/L\s*번호|HAWB/i.test(line));
  if (index < 0) return '';
  for (const line of lines.slice(index + 1, index + 12)) {
    const matches = [...line.matchAll(/\b[A-Z]{1,8}[A-Z0-9.-]{4,}\b/gi)].map(match => match[0]).filter(value => /\d/.test(value) && !/첨부파일|최대|PDF|XLSX|JPG|TIF/i.test(value));
    if (matches.length) return matches[matches.length - 1];
  }
  return '';
}

function extractDateNear(text, labelRe) {
  const match = text.match(labelRe);
  if (!match) return '';
  return normalizeDate(firstMatch(text.slice(match.index, match.index + 180), [/\b(\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/, /\b(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/, /\b([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\b/, /\b(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})\b/]));
}

function firstDate(text) {
  return normalizeDate(firstMatch(text, [/\b(\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/, /\b(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/, /\b([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\b/, /\b(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})\b/]));
}

function normalizeDate(value) {
  if (!value) return '';
  const raw = String(value).trim();
  let m = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  m = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (m) {
    const month = monthNumber(m[2]);
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (month) return `${year}-${month}-${pad2(m[1])}`;
  }
  m = raw.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (m) {
    const month = monthNumber(m[2]);
    if (month) return `${m[3]}-${month}-${pad2(m[1])}`;
  }
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return raw;
}

function monthNumber(value) {
  return { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }[String(value).toLowerCase()];
}

async function sha256(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function collectPdfFiles(dataTransfer) {
  const found = [];
  if (dataTransfer.items && dataTransfer.items.length) {
    for (const item of dataTransfer.items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        const files = await filesFromEntry(entry);
        found.push(...(Array.isArray(files) ? files : [files]));
      } else {
        const file = item.getAsFile();
        if (file) found.push(file);
      }
    }
  } else {
    found.push(...dataTransfer.files);
  }
  return found.filter(isPdf);
}

async function filesFromEntry(entry) {
  if (entry.isFile) return new Promise((resolve, reject) => entry.file(resolve, reject));
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const found = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) {
      const value = await filesFromEntry(child);
      found.push(...(Array.isArray(value) ? value : [value]));
    }
  }
  return found;
}

function resetApp() {
  if (STATE.processing) return;
  STATE.files = [];
  STATE.fileIndex = [];
  STATE.dhlChecks = [];
  STATE.activeTab = 'dhl';
  setActiveTabButton('dhl');
  byId('fileBody').innerHTML = '';
  byId('resultHead').innerHTML = '';
  byId('resultBody').innerHTML = '';
  show('filePanel', false);
  show('progress', false);
  show('summary', false);
  show('actions', false);
  show('results', false);
}

function setFileStatus(index, type, status) {
  if (type) STATE.files[index].type = type;
  STATE.files[index].status = status;
  renderFileList();
}

function setProgress(current, total, label) {
  const percent = total ? Math.round((current / total) * 100) : 0;
  byId('progressBar').style.width = `${percent}%`;
  byId('progressText').textContent = label;
}

function normalizeText(text) {
  return String(text || '').replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function valueOrBlank(value) {
  return value == null ? '' : value;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return (match[1] || match[0]).trim();
  }
  return '';
}

function blockAround(text, needle, size) {
  const index = text.indexOf(needle);
  if (index < 0) return text;
  return text.slice(Math.max(0, index - 500), Math.min(text.length, index + size));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusClass(status) {
  if (/완료|OK/.test(status)) return 'pill-ok';
  if (/오류|ERROR/.test(status)) return 'pill-error';
  if (/중복|DUPLICATE/.test(status)) return 'pill-dup';
  if (/검토|CHECK/.test(status)) return 'pill-check';
  return '';
}

function timestamp() {
  const date = new Date();
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function isPdf(file) {
  return file && file.name.toLowerCase().endsWith('.pdf');
}

function show(id, visible) {
  byId(id).hidden = !visible;
}

function byId(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
