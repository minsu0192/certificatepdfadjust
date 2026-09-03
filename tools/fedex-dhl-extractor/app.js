const CONFIG = {
  PDFJS_WORKER_URL: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  OCR_LANG: 'kor+eng',
  OCR_SCALE: 2,
};

const DOC_TYPES = {
  FEDEX_FREIGHT: 'FedEx Freight',
  FEDEX_DUTY: 'FedEx Duty',
  DHL_INVOICE: 'DHL 마감 인보이스',
  DHL_ETRADEBILL: 'DHL eTradebill',
  UNKNOWN: '미확인',
};

const STATE = {
  files: [],
  fileIndex: [],
  summaries: [],
  charges: [],
  reviews: [],
  activeTab: 'summary',
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
      document.querySelectorAll('.tab').forEach(item => item.classList.remove('is-active'));
      tab.classList.add('is-active');
      STATE.activeTab = tab.dataset.tab;
      renderResults();
    });
  });
}

function addFiles(files) {
  if (!files.length || STATE.processing) return;
  const seen = new Set(STATE.files.map(item => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
  for (const file of files) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    STATE.files.push({ file, type: '', status: '대기' });
  }
  renderFileList();
  show('filePanel', STATE.files.length > 0);
}

async function processFiles() {
  if (!STATE.files.length || STATE.processing) return;
  STATE.processing = true;
  STATE.fileIndex = [];
  STATE.summaries = [];
  STATE.charges = [];
  STATE.reviews = [];
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
        item.type = 'DUPLICATE';
        item.status = '중복 제외';
        STATE.fileIndex.push(fileIndexRow(item.file, hash, 'DUPLICATE', 0, '', hashes.get(hash), 'DUPLICATE'));
        STATE.reviews.push(reviewRow(item.file.name, '', 'Duplicate file', hashes.get(hash), item.file.name, '', '중복 제외'));
        renderFileList();
        continue;
      }
      hashes.set(hash, item.file.name);

      setFileStatus(i, '', '텍스트 추출 중');
      setProgress(i, STATE.files.length, `텍스트 추출 중 (${i + 1}/${STATE.files.length}): ${item.file.name}`);
      const parsed = await extractPdfText(item.file, message => {
        setProgress(i, STATE.files.length, `${message}: ${item.file.name}`);
      });
      const type = classifyDocument(item.file.name, parsed.text);
      item.type = type;
      item.status = type === DOC_TYPES.UNKNOWN ? '검토 필요' : '검증 중';
      renderFileList();

      const result = parseDocument(type, parsed.text, item.file.name, parsed.method);
      STATE.summaries.push(...result.summaries);
      STATE.charges.push(...result.charges);
      STATE.reviews.push(...result.reviews);

      const status = result.status || (result.reviews.length ? 'CHECK' : 'OK');
      item.status = status === 'OK' ? '완료' : status === 'ERROR' ? '오류' : '검토 필요';
      STATE.fileIndex.push(fileIndexRow(item.file, hash, type, parsed.pages, parsed.method, '', item.status));
      renderFileList();
    } catch (error) {
      item.status = '오류';
      STATE.fileIndex.push(fileIndexRow(item.file, '', item.type || DOC_TYPES.UNKNOWN, 0, '', '', 'ERROR'));
      STATE.reviews.push(reviewRow(item.file.name, '', 'PDF processing error', '', error.message || String(error), '', 'ERROR'));
      renderFileList();
    }
    await tick();
  }

  mergeDhlInvoices();
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

function classifyDocument(fileName, text) {
  const source = `${fileName}\n${text}`;
  if (/전자\s*세금계산서|승인번호|eTradebill/i.test(source)) return DOC_TYPES.DHL_ETRADEBILL;
  if (/DHL/i.test(source) && (/SHIPMENT DETAILS/i.test(source) || /INVOICE\s*S\d+/i.test(source))) return DOC_TYPES.DHL_INVOICE;
  if (/FedEx/i.test(source) && /DUTIES,\s*TAXES\s*&\s*OTHER\s*CHARGES|Duty Handling Fee/i.test(source)) return DOC_TYPES.FEDEX_DUTY;
  if (/FedEx|FREIGHT|Air Waybill Number/i.test(source)) return DOC_TYPES.FEDEX_FREIGHT;
  return DOC_TYPES.UNKNOWN;
}

function parseDocument(type, text, fileName, method) {
  if (type === DOC_TYPES.FEDEX_DUTY) return parseFedExDuty(text, fileName, method);
  if (type === DOC_TYPES.FEDEX_FREIGHT) return parseFedExFreight(text, fileName, method);
  if (type === DOC_TYPES.DHL_INVOICE) return parseDhlInvoice(text, fileName, method);
  if (type === DOC_TYPES.DHL_ETRADEBILL) return parseDhlEtradebill(text, fileName, method);
  return {
    summaries: [summaryRow({ carrier: 'UNKNOWN', documentType: type, sourceFile: fileName, extractionMethod: method, reviewStatus: 'CHECK' })],
    charges: [],
    reviews: [reviewRow(fileName, '', 'Unknown document type', '', type, '', 'CHECK')],
    status: 'CHECK',
  };
}

function parseFedExFreight(text, fileName, method) {
  const invoiceNumber = firstMatch(text, [/\b\d-\d{3}-\d{5}\b/, /Invoice\s*(?:Number|No\.?)\s*[:#]?\s*([A-Z0-9-]+)/i]);
  const invoiceDate = extractDateNear(text, /Invoice\s*Date/i) || firstDate(text);
  const total = amountNear(text, /Grand\s*Total|Total\s*Amount\s*Due|Amount\s*Due/i);
  const currency = extractCurrency(text);
  const reviews = [];
  if (!invoiceNumber) reviews.push(reviewRow(fileName, '', 'Missing invoice number', '', '', '', 'CHECK'));
  if (total == null) reviews.push(reviewRow(fileName, invoiceNumber, 'Missing grand total', '', '', '', 'CHECK'));
  return {
    summaries: [summaryRow({ carrier: 'FedEx', documentType: 'FREIGHT', invoiceNumber, invoiceDate, currency, grandTotal: total, sourceFile: fileName, extractionMethod: method, reviewStatus: reviews.length ? 'CHECK' : 'OK' })],
    charges: [],
    reviews,
    status: reviews.length ? 'CHECK' : 'OK',
  };
}

function parseFedExDuty(text, fileName, method) {
  const base = parseFedExFreight(text, fileName, method);
  base.summaries[0]['Document Type'] = 'DUTY';
  const invoiceNumber = base.summaries[0]['Invoice Number'];
  const blocks = splitByAnchors(text, /Ship\s*Date\s*[:：]?/gi);
  const charges = [];
  const reviews = [...base.reviews];

  for (const block of blocks.length ? blocks : [text]) {
    const shipDate = extractDateNear(block, /Ship\s*Date/i) || firstDate(block);
    const awb = firstMatch(block, [/Air\s*Waybill\s*(?:Number|No\.?)\s*[:#]?\s*(\d{8,15})/i, /\b(\d{12})\b/]);
    if (!awb && block !== text) continue;
    const customsDate = extractDateNear(block, /Customs\s*Entry\s*Date/i);
    const recipient = textAfterLabel(block, /Recipient/i);
    const reference = textAfterLabel(block, /FedEx\s*Reference|Reference/i);
    const total = amountNear(block, /Total/i);
    const chargeNames = ['Duty & Tax', 'VAT/Consumption Tax', 'Korea VAT', 'Duty Handling Fee'];
    let sum = 0;
    let found = 0;
    for (const chargeName of chargeNames) {
      const amount = amountNear(block, new RegExp(escapeRegExp(chargeName).replace(/\\\//g, '\\s*/\\s*'), 'i'));
      if (amount != null) {
        found += 1;
        sum += amount;
      }
      charges.push(chargeRow({ carrier: 'FedEx', documentType: 'DUTY', invoiceNumber, awbNumber: awb, shipDate, customsEntryDate: customsDate, recipient, fedexReference: reference, charge: chargeName, amount, sourceFile: fileName }));
    }
    if (found < 4) reviews.push(reviewRow(fileName, awb || invoiceNumber, 'Missing FedEx Duty charge item', '4 charge rows', `${found} found`, '', 'CHECK'));
    if (total != null && found && Math.round(sum) !== Math.round(total)) {
      reviews.push(reviewRow(fileName, awb || invoiceNumber, 'AWB charge sum mismatch', total, sum, sum - total, 'CHECK'));
    }
  }

  const grandTotal = base.summaries[0]['Grand Total'];
  const chargeSum = charges.reduce((sum, row) => sum + (Number(row.Amount) || 0), 0);
  if (grandTotal != null && chargeSum && Math.round(chargeSum) !== Math.round(grandTotal)) {
    reviews.push(reviewRow(fileName, invoiceNumber, 'Grand total mismatch', grandTotal, chargeSum, chargeSum - grandTotal, 'CHECK'));
  }
  base.summaries[0]['Review Status'] = reviews.length ? 'CHECK' : 'OK';
  return { summaries: base.summaries, charges, reviews, status: reviews.length ? 'CHECK' : 'OK' };
}

function parseDhlInvoice(text, fileName, method) {
  const invoiceNumbers = unique([...text.matchAll(/\bINVOICE\s+(S\d+)\b/gi)].map(match => match[1].toUpperCase()));
  const targets = invoiceNumbers.length ? invoiceNumbers : [''];
  const summaries = [];
  const charges = [];
  const reviews = [];

  for (const invoiceNumber of targets) {
    const block = invoiceNumber ? dhlInvoiceBlock(text, invoiceNumber) : text;
    const invoiceLabel = invoiceNumber ? `INVOICE ${invoiceNumber}` : '';
    const invoiceDate = normalizeDate(firstMatch(block, [/INVOICE\s+DATE\s+([0-9]{1,2}-[A-Za-z]{3}-[0-9]{2,4})/i])) || extractDateNear(block, /Invoice\s*Date|Date/i) || firstDate(block);
    const shipmentNumber = firstMatch(block, [/SHIPMENT\s+(S\d+)/i, /Shipment\s*(?:Number|No\.?)\s*[:#]?\s*([A-Z0-9-]+)/i]);
    const subtotal = parseAmount(firstMatch(block, [/\bSUBTOTAL\s+([\d,]+(?:\.\d+)?)/i]));
    const vat = parseAmount(firstMatch(block, [/\bVAT\s+([\d,]+(?:\.\d+)?)/i]));
    const total = parseAmount(firstMatch(block, [/\bTOTAL\s+KRW\s+([\d,]+(?:\.\d+)?)/i]));
    const invoiceCharges = extractDhlCharges(block, invoiceLabel, shipmentNumber, fileName);
    charges.push(...invoiceCharges);

    const zeroSum = invoiceCharges.filter(row => row['VAT Rate'] === 'Zero Rated').reduce((sum, row) => sum + (Number(row['Charge Amount']) || 0), 0);
    const tenSum = invoiceCharges.filter(row => row['VAT Rate'] === '10%').reduce((sum, row) => sum + (Number(row['Charge Amount']) || 0), 0);
    if (!invoiceNumber) reviews.push(reviewRow(fileName, '', 'Missing DHL invoice number', '', '', '', 'CHECK'));
    if (!invoiceCharges.length) reviews.push(reviewRow(fileName, invoiceLabel, 'Missing DHL charge detail', 'Charge rows', '', '', 'CHECK'));
    if (subtotal != null && invoiceCharges.length && Math.abs((zeroSum + tenSum) - subtotal) > 1) reviews.push(reviewRow(fileName, invoiceLabel, 'DHL subtotal mismatch', subtotal, zeroSum + tenSum, zeroSum + tenSum - subtotal, 'CHECK'));
    if (vat != null && tenSum && Math.abs(Math.round(tenSum * 0.1) - vat) > 1) reviews.push(reviewRow(fileName, invoiceLabel, 'DHL VAT mismatch', vat, Math.round(tenSum * 0.1), Math.round(tenSum * 0.1) - vat, 'CHECK'));
    if (subtotal != null && vat != null && total != null && Math.abs((subtotal + vat) - total) > 1) reviews.push(reviewRow(fileName, invoiceLabel, 'DHL total mismatch', total, subtotal + vat, subtotal + vat - total, 'CHECK'));

    summaries.push(summaryRow({ carrier: 'DHL', documentType: 'FREIGHT_INVOICE', invoiceNumber: invoiceLabel, invoiceDate, shipmentNumber, subtotal, vat, totalKrw: total, sourceFile: fileName, extractionMethod: method, reviewStatus: reviews.some(row => row['Invoice/AWB'] === invoiceLabel) ? 'CHECK' : 'OK' }));
  }
  return { summaries, charges, reviews, status: reviews.length ? 'CHECK' : 'OK' };
}

function extractDhlCharges(text, invoiceNumber, shipmentNumber, fileName) {
  const rows = [];
  const chargeStart = text.search(/CHARGES\s*\n\s*DESCRIPTION/i);
  const totalStart = text.search(/TOTAL\s+CHARGES/i);
  const scope = chargeStart >= 0 && totalStart > chargeStart ? text.slice(chargeStart, totalStart) : text;
  const lines = scope.split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^CHARGES$|^DESCRIPTION\b|DHL GLOBAL FORWARDING/i.test(line)) continue;
    const row = line.match(/^(.+?)\s+(Zero\s+Rated|10%)\s+([\d,]+(?:\.\d+)?)$/i);
    if (!row) continue;
    const amount = parseAmount(row[3]);
    if (amount == null || Math.abs(amount) < 1) continue;
    const desc = row[1].replace(/\s+/g, ' ').trim();
    if (desc.length < 3) continue;
    const vatRate = /zero\s*rated/i.test(row[2]) ? 'Zero Rated' : '10%';
    rows.push(chargeRow({ carrier: 'DHL', documentType: 'FREIGHT_INVOICE', invoiceNumber, shipmentNumber, chargeDescription: desc, vatRate, chargeAmount: amount, sourceFile: fileName }));
  }
  return rows;
}

function parseDhlEtradebill(text, fileName, method) {
  const approval = firstMatch(text, [/승인번호\s*[:：]?\s*([A-Za-z0-9-]{12,})/i, /Approval\s*(?:Number|No\.?)\s*[:#]?\s*([A-Za-z0-9-]{12,})/i]);
  const issueDate = extractDateNear(text, /작성일자|Issue\s*Date|Date/i) || firstDate(text);
  const regNos = [...text.matchAll(/\b(\d{3})[\s-]+(\d{2})[\s-]+(\d{5})\b/g)].map(match => `${match[1]}-${match[2]}-${match[3]}`);
  const supplierRegNo = regNos[0] || '';
  const buyerRegNo = regNos[1] || '';
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const supplierName = lineAfter(lines, supplierRegNo.replace(/-/g, ' ')) || textAfterLabel(text, /공급자\s*상호|Supplier/i);
  const buyerName = lineAfter(lines, buyerRegNo.replace(/-/g, ' '));
  const amounts = extractEtradebillAmounts(text);
  const supplyAmount = amounts.supplyAmount;
  let vat = amounts.vat;
  const total = amounts.total;
  const taxType = /영세|Zero\s*Rated|0\s*%/i.test(text) ? 'Zero Rated' : 'Taxable';
  if (vat == null && taxType === 'Zero Rated') vat = 0;
  const itemInfo = firstMatch(text, [/\bNO\.\s*([^\n]+)/i, /참조정보\s*\n([^\n]+)/i, /품목\s*[:：]?\s*([^\n]+)/i]);
  const reviews = [];
  if (!approval) reviews.push(reviewRow(fileName, '', 'Missing approval number', '', '', '', 'CHECK'));
  if (supplyAmount == null) reviews.push(reviewRow(fileName, approval, 'Missing supply amount', '', '', '', 'CHECK'));
  if (total == null) reviews.push(reviewRow(fileName, approval, 'Missing total amount', '', '', '', 'CHECK'));
  if (supplyAmount != null && vat != null && total != null && Math.abs((supplyAmount + vat) - total) > 1) {
    reviews.push(reviewRow(fileName, approval, 'eTradebill total mismatch', total, supplyAmount + vat, supplyAmount + vat - total, 'CHECK'));
  }

  return {
    summaries: [summaryRow({ carrier: 'DHL', documentType: 'ETRADEBILL', approvalNumber: approval, approvalLast8: approval ? approval.replace(/\D/g, '').slice(-8) : '', issueDate, supplierName, buyerName, supplierRegNo, buyerRegNo, supplyAmount, vat, totalAmount: total, taxType, itemInfo, sourceFile: fileName, extractionMethod: method, reviewStatus: reviews.length ? 'CHECK' : 'OK' })],
    charges: [],
    reviews,
    status: reviews.length ? 'CHECK' : 'OK',
  };
}

function mergeDhlInvoices() {
  const seen = new Map();
  const merged = [];
  for (const row of STATE.summaries) {
    if (row.Carrier !== 'DHL' || row['Document Type'] !== 'FREIGHT_INVOICE' || !row['Invoice Number']) {
      merged.push(row);
      continue;
    }
    const key = row['Invoice Number'];
    if (!seen.has(key)) {
      seen.set(key, row);
      merged.push(row);
      continue;
    }
    const existing = seen.get(key);
    existing['Source File'] = unique([existing['Source File'], row['Source File']].filter(Boolean).join(' | ').split(' | ')).join(' | ');
    STATE.reviews.push(reviewRow(row['Source File'], key, 'Repeated DHL invoice merged', existing['Source File'], row['Source File'], '', '병합'));
  }
  STATE.summaries = merged;
}

function summaryRow(data) {
  return {
    Carrier: data.carrier || '',
    'Document Type': data.documentType || '',
    'Invoice Number': data.invoiceNumber || '',
    'Invoice Date': data.invoiceDate || '',
    'Shipment Period': data.shipmentPeriod || '',
    Currency: data.currency || '',
    'Grand Total': valueOrBlank(data.grandTotal),
    'Shipment Number': data.shipmentNumber || '',
    Subtotal: valueOrBlank(data.subtotal),
    VAT: valueOrBlank(data.vat),
    'Total KRW': valueOrBlank(data.totalKrw),
    'Approval Number': data.approvalNumber || '',
    'Approval Last 8 Digits': data.approvalLast8 || '',
    작성일자: data.issueDate || '',
    '공급자 상호': data.supplierName || '',
    '공급자 사업자등록번호': data.supplierRegNo || '',
    '공급받는자 상호': data.buyerName || '',
    '공급받는자 사업자등록번호': data.buyerRegNo || '',
    공급가액: valueOrBlank(data.supplyAmount),
    세액: valueOrBlank(data.vat),
    합계금액: valueOrBlank(data.totalAmount),
    '과세/영세율 구분': data.taxType || '',
    '품목 또는 참조정보': data.itemInfo || '',
    'Source File': data.sourceFile || '',
    'Extraction Method': data.extractionMethod || '',
    'Review Status': data.reviewStatus || 'OK',
  };
}

function chargeRow(data) {
  return {
    Carrier: data.carrier || '',
    'Document Type': data.documentType || '',
    'Invoice Number': data.invoiceNumber || '',
    'AWB Number': data.awbNumber || '',
    'Ship Date': data.shipDate || '',
    'Customs Entry Date': data.customsEntryDate || '',
    Recipient: data.recipient || '',
    'FedEx Reference': data.fedexReference || '',
    Charge: data.charge || '',
    Amount: valueOrBlank(data.amount),
    'Shipment Number': data.shipmentNumber || '',
    'Charge Description': data.chargeDescription || data.charge || '',
    'VAT Rate': data.vatRate || '',
    'Charge Amount': valueOrBlank(data.chargeAmount),
    'Source File': data.sourceFile || '',
  };
}

function reviewRow(file, target, reason, expected, extracted, difference, action) {
  return {
    File: file || '',
    'Invoice/AWB': target || '',
    Reason: reason || '',
    Expected: valueOrBlank(expected),
    Extracted: valueOrBlank(extracted),
    Difference: valueOrBlank(difference),
    Action: action || '',
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
  byId('statFiles').textContent = STATE.fileIndex.length;
  byId('statDone').textContent = STATE.fileIndex.filter(row => row.Status === '완료').length;
  byId('statCheck').textContent = STATE.reviews.filter(row => row.Action === 'CHECK').length;
  byId('statIssue').textContent = STATE.fileIndex.filter(row => /DUPLICATE|ERROR|오류|중복/.test(row.Status)).length;
}

function renderResults() {
  const data = STATE.activeTab === 'charges' ? STATE.charges : STATE.activeTab === 'review' ? STATE.reviews : STATE.summaries;
  const columns = getColumns(data, STATE.activeTab);
  byId('resultHead').innerHTML = `<tr>${columns.map(col => `<th>${esc(col)}</th>`).join('')}</tr>`;
  byId('resultBody').innerHTML = data.map(row => `<tr class="${row['Review Status'] === 'CHECK' || row.Action === 'CHECK' ? 'row-check' : row.Action === 'ERROR' ? 'row-error' : ''}">${columns.map(col => `<td>${esc(row[col])}</td>`).join('')}</tr>`).join('');
}

function exportExcel() {
  const wb = XLSX.utils.book_new();
  appendSheet(wb, 'File_Index', STATE.fileIndex);
  appendSheet(wb, 'Invoice_Summary', STATE.summaries);
  appendSheet(wb, 'Charge_Detail', STATE.charges);
  appendSheet(wb, 'Review', STATE.reviews);
  XLSX.writeFile(wb, `FedEx_DHL_Extraction_${timestamp()}.xlsx`);
}

function appendSheet(wb, name, rows) {
  const columns = getColumns(rows, name);
  const data = [columns, ...rows.map(row => columns.map(col => row[col] == null ? '' : row[col]))];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = columns.map(col => ({ wch: Math.max(12, Math.min(36, col.length + 6)) }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: columns.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, name);
}

function getColumns(rows, fallback) {
  const presets = {
    summary: ['Carrier', 'Document Type', 'Invoice Number', 'Invoice Date', 'Shipment Period', 'Currency', 'Grand Total', 'Shipment Number', 'Subtotal', 'VAT', 'Total KRW', 'Approval Number', 'Approval Last 8 Digits', '작성일자', '공급자 상호', '공급자 사업자등록번호', '공급받는자 상호', '공급받는자 사업자등록번호', '공급가액', '세액', '합계금액', '과세/영세율 구분', '품목 또는 참조정보', 'Source File', 'Extraction Method', 'Review Status'],
    charges: ['Carrier', 'Document Type', 'Invoice Number', 'AWB Number', 'Ship Date', 'Customs Entry Date', 'Recipient', 'FedEx Reference', 'Charge', 'Amount', 'Shipment Number', 'Charge Description', 'VAT Rate', 'Charge Amount', 'Source File'],
    review: ['File', 'Invoice/AWB', 'Reason', 'Expected', 'Extracted', 'Difference', 'Action'],
    File_Index: ['File', 'SHA-256', 'Document Type', 'Pages', 'Extraction Method', 'Duplicate Of', 'Status'],
    Invoice_Summary: ['Carrier', 'Document Type', 'Invoice Number', 'Invoice Date', 'Shipment Period', 'Currency', 'Grand Total', 'Shipment Number', 'Subtotal', 'VAT', 'Total KRW', 'Approval Number', 'Approval Last 8 Digits', '작성일자', '공급자 상호', '공급자 사업자등록번호', '공급받는자 상호', '공급받는자 사업자등록번호', '공급가액', '세액', '합계금액', '과세/영세율 구분', '품목 또는 참조정보', 'Source File', 'Extraction Method', 'Review Status'],
    Charge_Detail: ['Carrier', 'Document Type', 'Invoice Number', 'AWB Number', 'Ship Date', 'Customs Entry Date', 'Recipient', 'FedEx Reference', 'Charge', 'Amount', 'Shipment Number', 'Charge Description', 'VAT Rate', 'Charge Amount', 'Source File'],
    Review: ['File', 'Invoice/AWB', 'Reason', 'Expected', 'Extracted', 'Difference', 'Action'],
  };
  if (presets[fallback]) return presets[fallback];
  if (!rows.length) return [];
  return Object.keys(rows[0]);
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
  const start = Math.max(0, match.index - 80);
  const end = Math.min(text.length, match.index + match[0].length + 220);
  const scope = text.slice(start, end);
  const values = [...scope.matchAll(/-?\(?\d[\d,]*(?:\.\d+)?\)?/g)].map(item => parseAmount(item[0])).filter(value => value != null);
  return values.length ? values[values.length - 1] : null;
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
  const pairMatches = [...text.matchAll(/(\d{1,3}(?:,\d{3})+)\s+(\d{1,3}(?:,\d{3})+)/g)]
    .map(match => ({ index: match.index, first: parseAmount(match[1]), second: parseAmount(match[2]) }));
  const headerIndex = text.search(/공급가액\s+세액/);
  const supplyPair = pairMatches.find(item => headerIndex < 0 || item.index > headerIndex);
  const totalIndex = text.search(/합계금액/);
  const totals = [...text.slice(Math.max(0, totalIndex)).matchAll(/(\d{1,3}(?:,\d{3})+)/g)].map(match => parseAmount(match[1]));
  const expectedTotal = supplyPair && supplyPair.first != null && supplyPair.second != null ? supplyPair.first + supplyPair.second : null;
  let total = null;
  if (expectedTotal != null) total = totals.find(value => value === expectedTotal) || null;
  if (total == null && expectedTotal != null && text.includes(String(expectedTotal).replace(/\B(?=(\d{3})+(?!\d))/g, ','))) total = expectedTotal;
  return {
    supplyAmount: supplyPair ? supplyPair.first : null,
    vat: supplyPair ? supplyPair.second : null,
    total,
  };
}

function lineAfter(lines, value) {
  if (!value) return '';
  const normalizedValue = value.replace(/\D/g, '');
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].replace(/\D/g, '') === normalizedValue) return lines[i + 1] || '';
  }
  return '';
}

function extractDateNear(text, labelRe) {
  const match = text.match(labelRe);
  if (!match) return '';
  return normalizeDate(firstMatch(text.slice(match.index, match.index + 180), [/\b(\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/, /\b(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/, /\b([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\b/]));
}

function firstDate(text) {
  return normalizeDate(firstMatch(text, [/\b(\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/, /\b(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/, /\b([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\b/]));
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
    const month = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }[m[2].toLowerCase()];
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (month) return `${year}-${month}-${pad2(m[1])}`;
  }
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return raw;
}

function extractCurrency(text) {
  const m = text.match(/\b(KRW|USD|EUR|JPY|GBP|CNY|CHF|HKD|SGD|AUD|CAD)\b/i);
  return m ? m[1].toUpperCase() : 'KRW';
}

function textAfterLabel(text, labelRe) {
  const match = text.match(labelRe);
  if (!match) return '';
  const line = text.slice(match.index, match.index + 220).split('\n')[0];
  return line.replace(labelRe, '').replace(/[:：#]/g, '').trim().slice(0, 80);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return (match[1] || match[0]).trim();
  }
  return '';
}

function splitByAnchors(text, anchorRe) {
  const matches = [...text.matchAll(anchorRe)];
  return matches.map((match, index) => text.slice(match.index, matches[index + 1] ? matches[index + 1].index : text.length));
}

function blockAround(text, needle, size) {
  const index = text.indexOf(needle);
  if (index < 0) return text;
  return text.slice(Math.max(0, index - 500), Math.min(text.length, index + size));
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
  STATE.summaries = [];
  STATE.charges = [];
  STATE.reviews = [];
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
