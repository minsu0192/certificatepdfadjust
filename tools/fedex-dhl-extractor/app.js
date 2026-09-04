const CONFIG = {
  PDFJS_WORKER_URL: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  OCR_LANG: 'kor+eng',
  OCR_SCALE: 2,
};

const DOC_TYPES = {
  FEDEX_FREIGHT: 'FedEx Freight',
  FEDEX_DUTY: 'FedEx Duty',
  FEDEX_UNKNOWN: 'FedEx Unknown',
  DHL_INVOICE: 'DHL 마감 인보이스',
  DHL_ETRADEBILL: 'DHL eTradebill',
  UNKNOWN: '미확인',
};

const STATE = {
  files: [],
  fileIndex: [],
  fedexChecks: [],
  summaries: [],
  charges: [],
  reviews: [],
  activeTab: 'fedex',
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
  for (const file of files) {
    STATE.files.push({ file, type: '', status: '대기' });
  }
  renderFileList();
  show('filePanel', STATE.files.length > 0);
}

async function processFiles() {
  if (!STATE.files.length || STATE.processing) return;
  STATE.processing = true;
  STATE.fileIndex = [];
  STATE.fedexChecks = [];
  STATE.summaries = [];
  STATE.charges = [];
  STATE.reviews = [];
  STATE.activeTab = 'fedex';
  setActiveTabButton('fedex');
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
        const original = hashes.get(hash);
        const duplicateOf = original.name || original;
        item.type = 'DUPLICATE';
        item.status = '중복 제외';
        STATE.fileIndex.push(fileIndexRow(item.file, hash, 'DUPLICATE', 0, '', duplicateOf, 'DUPLICATE'));
        if (original.isFedEx || isPotentialFedExFile(item.file.name)) STATE.fedexChecks.push(fedexCheckRow({ sourceFile: item.file.name, documentType: 'DUPLICATE', vatExtraction: 'Duplicate', reason: `Duplicate of ${duplicateOf}`, status: 'DUPLICATE' }));
        STATE.reviews.push(reviewRow(item.file.name, '', 'Duplicate file', duplicateOf, item.file.name, '', '중복 제외'));
        renderFileList();
        continue;
      }
      hashes.set(hash, { name: item.file.name, isFedEx: isPotentialFedExFile(item.file.name) });

      setFileStatus(i, '', '텍스트 추출 중');
      setProgress(i, STATE.files.length, `텍스트 추출 중 (${i + 1}/${STATE.files.length}): ${item.file.name}`);
      const parsed = await extractPdfText(item.file, message => {
        setProgress(i, STATE.files.length, `${message}: ${item.file.name}`);
      });
      const type = classifyDocument(item.file.name, parsed.text);
      const hashInfo = hashes.get(hash);
      if (hashInfo) hashInfo.isFedEx = hashInfo.isFedEx || isFedExDocumentType(type);
      item.type = type;
      item.status = type === DOC_TYPES.UNKNOWN ? '검토 필요' : '검증 중';
      renderFileList();

      const result = parseDocument(type, parsed.text, item.file.name, parsed.method);
      STATE.fedexChecks.push(...(result.fedexChecks || []));
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
      if (isPotentialFedExFile(item.file.name)) STATE.fedexChecks.push(fedexCheckRow({ sourceFile: item.file.name, documentType: 'UNKNOWN', vatExtraction: 'Review', reason: error.message || String(error), status: 'ERROR' }));
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
  if (/FedEx|Federal\s*Express|페더럴\s*익스프레스/i.test(source)) {
    if (/DUTIES,\s*TAXES\s*&\s*OTHER\s*CHARGES|VAT\/Consumption\s*Tax|Korea\s*VAT|Duty\s*Handling\s*Fee/i.test(source)) return DOC_TYPES.FEDEX_DUTY;
    if (/\bFREIGHT\b|Freight\s*Charges|항공\s*운송\s*요금/i.test(source)) return DOC_TYPES.FEDEX_FREIGHT;
    return DOC_TYPES.FEDEX_UNKNOWN;
  }
  if (/전자\s*세금계산서|승인번호|eTradebill/i.test(source)) return DOC_TYPES.DHL_ETRADEBILL;
  if (/DHL/i.test(source) && (/SHIPMENT DETAILS/i.test(source) || /INVOICE\s*S\d+/i.test(source))) return DOC_TYPES.DHL_INVOICE;
  return DOC_TYPES.UNKNOWN;
}

function parseDocument(type, text, fileName, method) {
  if (type === DOC_TYPES.FEDEX_DUTY) return parseFedExDuty(text, fileName, method);
  if (type === DOC_TYPES.FEDEX_FREIGHT) return parseFedExFreight(text, fileName, method);
  if (type === DOC_TYPES.FEDEX_UNKNOWN) return parseFedExUnknown(text, fileName, method);
  if (type === DOC_TYPES.DHL_INVOICE) return parseDhlInvoice(text, fileName, method);
  if (type === DOC_TYPES.DHL_ETRADEBILL) return parseDhlEtradebill(text, fileName, method);
  return {
    fedexChecks: [],
    summaries: [summaryRow({ carrier: 'UNKNOWN', documentType: type, sourceFile: fileName, extractionMethod: method, reviewStatus: 'CHECK' })],
    charges: [],
    reviews: [reviewRow(fileName, '', 'Unknown document type', '', type, '', 'CHECK')],
    status: 'CHECK',
  };
}

function parseFedExFreight(text, fileName, method) {
  const invoiceNumber = firstMatch(text, [/Invoice\s*(?:Number|No\.?)\s*[:#]?\s*(\d-\d{3}-\d{5})/i, /\b\d-\d{3}-\d{5}\b/]);
  const invoiceDate = extractDateNear(text, /Invoice\s*Date/i) || firstDate(text);
  const total = amountNear(text, /Grand\s*Total|Total\s*Amount\s*Due|Amount\s*Due/i);
  const currency = extractCurrency(text);
  const shipmentPeriod = extractShipmentPeriod(text);
  const reviews = [];
  if (!invoiceNumber) reviews.push(reviewRow(fileName, '', 'Missing invoice number', '', '', '', 'CHECK'));
  if (!invoiceDate) reviews.push(reviewRow(fileName, invoiceNumber, 'Missing invoice date', '', '', '', 'CHECK'));
  const status = reviews.length ? 'CHECK' : 'OK';
  const reason = reviews.length ? reviews.map(row => row.Reason).join('; ') : 'Freight Invoice - No VAT reconciliation required';
  return {
    fedexChecks: [fedexCheckRow({ invoiceNumber, invoiceDate, currency, invoiceTotal: total, documentType: 'FREIGHT', vatExtraction: 'Excluded', reason, sourceFile: fileName, status })],
    summaries: [summaryRow({ carrier: 'FedEx', documentType: 'FREIGHT', invoiceNumber, invoiceDate, shipmentPeriod, currency, grandTotal: total, sourceFile: fileName, extractionMethod: method, reviewStatus: reviews.length ? 'CHECK' : 'OK' })],
    charges: [],
    reviews,
    status,
  };
}

function parseFedExDuty(text, fileName, method) {
  const invoiceNumber = firstMatch(text, [/Invoice\s*(?:Number|No\.?)\s*[:#]?\s*(\d-\d{3}-\d{5})/i, /\b\d-\d{3}-\d{5}\b/]);
  const invoiceDate = extractDateNear(text, /Invoice\s*Date/i) || firstDate(text);
  const invoiceTotal = amountNear(text, /Grand\s*Total|Total\s*Amount\s*Due|Amount\s*Due/i);
  const currency = extractCurrency(text);
  const reviews = [];
  if (!invoiceNumber) reviews.push(reviewRow(fileName, '', 'Missing invoice number', '', '', '', 'CHECK'));
  if (!invoiceDate) reviews.push(reviewRow(fileName, invoiceNumber, 'Missing invoice date', '', '', '', 'CHECK'));
  const shipmentBlocks = fedexAwbBlocks(text);
  if (!shipmentBlocks.length) reviews.push(reviewRow(fileName, invoiceNumber, 'Missing FedEx AWB blocks', 'Air Waybill Number', '', '', 'CHECK'));
  const fedexChecks = (shipmentBlocks.length ? shipmentBlocks : [text]).map(block => {
    const awbNumber = firstMatch(block, [/Air\s*Waybill\s*(?:Number|No\.?)\s*[:#]?\s*(\d{8,15})/i, /\b(\d{10,15})\b/]);
    const dutyVat = sumAmountsForLabel(block, /VAT\/Consumption\s*Tax/i);
    const handlingVat = sumAmountsForLabel(block, /Korea\s*VAT/i);
    const totalVat = sumPresentAmounts([dutyVat, handlingVat]);
    const rowReviews = [];
    if (!awbNumber) rowReviews.push('Missing AWB number');
    if (dutyVat == null) rowReviews.push('Missing FedEx duty VAT');
    if (handlingVat == null) rowReviews.push('Missing FedEx handling VAT');
    const status = reviews.length || rowReviews.length ? 'CHECK' : 'OK';
    for (const reason of rowReviews) reviews.push(reviewRow(fileName, awbNumber || invoiceNumber, reason, '', '', '', 'CHECK'));
    return fedexCheckRow({
      invoiceNumber,
      invoiceDate,
      awbNumber,
      currency,
      invoiceTotal,
      documentType: 'DUTY',
      vatExtraction: 'Included',
      dutyVat,
      handlingVat,
      totalVat,
      reason: rowReviews.join('; '),
      sourceFile: fileName,
      status,
    });
  });
  const totalVat = fedexChecks.reduce((sum, row) => sum + (Number(row['Total VAT']) || 0), 0);
  const status = reviews.length ? 'CHECK' : 'OK';
  return {
    fedexChecks,
    summaries: [summaryRow({ carrier: 'FedEx', documentType: 'DUTY', invoiceNumber, invoiceDate, currency, grandTotal: invoiceTotal, vat: totalVat, sourceFile: fileName, extractionMethod: method, reviewStatus: status })],
    charges: [],
    reviews,
    status,
  };
}

function parseFedExUnknown(text, fileName, method) {
  const invoiceNumber = firstMatch(text, [/Invoice\s*(?:Number|No\.?)\s*[:#]?\s*(\d-\d{3}-\d{5})/i, /\b\d-\d{3}-\d{5}\b/]);
  const invoiceDate = extractDateNear(text, /Invoice\s*Date/i) || firstDate(text);
  const invoiceTotal = amountNear(text, /Grand\s*Total|Total\s*Amount\s*Due|Amount\s*Due/i);
  const currency = extractCurrency(text);
  const reason = 'FedEx document type could not be determined';
  return {
    fedexChecks: [fedexCheckRow({ invoiceNumber, invoiceDate, currency, invoiceTotal, documentType: 'UNKNOWN', vatExtraction: 'Review', reason, sourceFile: fileName, status: 'CHECK' })],
    summaries: [summaryRow({ carrier: 'FedEx', documentType: 'UNKNOWN', invoiceNumber, invoiceDate, currency, grandTotal: invoiceTotal, sourceFile: fileName, extractionMethod: method, reviewStatus: 'CHECK' })],
    charges: [],
    reviews: [reviewRow(fileName, invoiceNumber, reason, 'DUTY or FREIGHT', '', '', 'CHECK')],
    status: 'CHECK',
  };
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
    const subtotal = amountNear(block, /\bSUBTOTAL\b/i);
    const vat = amountNear(block, /\bVAT\b/i);
    const total = amountNear(block, /\bTOTAL\s+KRW\b/i);
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
    rows.push(chargeRow({
      carrier: 'DHL',
      documentType: 'FREIGHT_INVOICE',
      invoiceNumber,
      shipmentNumber,
      chargeDescription: desc,
      vatRate,
      chargeAmount: amount,
      sourceFile: fileName,
      reconScope: vatRate === '10%' ? 'DHL taxable freight' : 'DHL zero-rated freight',
      taxInvoiceVendor: 'DHL',
      reconKey: [invoiceNumber, shipmentNumber, desc].filter(Boolean).join(' | '),
      taxBaseCandidate: vatRate === '10%' ? amount : 0,
      vatCandidate: vatRate === '10%' ? Math.round(amount * 0.1) : 0,
    }));
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
    'Recon Scope': data.reconScope || '',
    'Tax Invoice Vendor': data.taxInvoiceVendor || '',
    'Recon Key': data.reconKey || '',
    'Tax Base Candidate': valueOrBlank(data.taxBaseCandidate),
    'VAT Candidate': valueOrBlank(data.vatCandidate),
    Carrier: data.carrier || '',
    'Document Type': data.documentType || '',
    'Invoice Number': data.invoiceNumber || '',
    'AWB Number': data.awbNumber || '',
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

function fedexCheckRow(data) {
  return {
    'Vendor Name': 'FedEx',
    'Invoice Number': data.invoiceNumber || '',
    'Invoice Date': data.invoiceDate || '',
    'AWB Number': data.awbNumber || '',
    Currency: data.currency || '',
    'Invoice Total': valueOrBlank(data.invoiceTotal),
    'Document Type': data.documentType || '',
    'VAT Extraction': data.vatExtraction || '',
    'Duty VAT': valueOrBlank(data.dutyVat),
    'Handling VAT': valueOrBlank(data.handlingVat),
    'Total VAT': valueOrBlank(data.totalVat),
    Reason: data.reason || '',
    'Source File': data.sourceFile || '',
    Status: data.status || 'OK',
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
  const stats = fedexStats();
  byId('statFiles').textContent = stats.total;
  byId('statDone').textContent = stats.duty;
  byId('statCheck').textContent = stats.freight;
  byId('statIssue').textContent = stats.unknown;
  byId('statDuplicate').textContent = stats.duplicate;
  byId('statFormula').textContent = `${stats.total} = ${stats.duty} + ${stats.freight} + ${stats.unknown} + ${stats.duplicate}`;
  byId('statFormula').className = stats.valid ? 'formula-ok' : 'formula-error';
}

function renderResults() {
  const data = STATE.activeTab === 'files' ? STATE.fileIndex : sortedFedExChecks();
  const columns = getColumns(data, STATE.activeTab);
  byId('resultHead').innerHTML = `<tr>${columns.map(col => `<th>${esc(col)}</th>`).join('')}</tr>`;
  byId('resultBody').innerHTML = data.map(row => `<tr class="${row.Status === 'CHECK' || row['Review Status'] === 'CHECK' || row.Action === 'CHECK' ? 'row-check' : row.Status === 'ERROR' || row.Action === 'ERROR' ? 'row-error' : row.Status === 'DUPLICATE' ? 'row-duplicate' : ''}">${columns.map(col => `<td>${esc(row[col])}</td>`).join('')}</tr>`).join('');
}

function exportExcel() {
  const wb = XLSX.utils.book_new();
  appendFedExCheckSheet(wb);
  appendSheet(wb, 'File_Index', STATE.fileIndex);
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

function appendFedExCheckSheet(wb) {
  const stats = fedexStats();
  const columns = getColumns([], 'FedEx_Invoice_Check');
  const data = [
    ['Total FedEx PDFs', stats.total],
    ['Duty Invoice Count', stats.duty],
    ['Freight Invoice Count', stats.freight],
    ['Unknown Count', stats.unknown],
    ['Duplicate Count', stats.duplicate],
    ['Validation', `${stats.total} = ${stats.duty} + ${stats.freight} + ${stats.unknown} + ${stats.duplicate}`, stats.valid ? 'OK' : 'CHECK'],
    [],
    columns,
    ...sortedFedExChecks().map(row => columns.map(col => row[col] == null ? '' : row[col])),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = columns.map(col => ({ wch: Math.max(12, Math.min(34, col.length + 6)) }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 7, c: 0 }, e: { r: Math.max(7, STATE.fedexChecks.length + 7), c: columns.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, 'FedEx_Invoice_Check');
}

function getColumns(rows, fallback) {
  const presets = {
    fedex: ['Vendor Name', 'Invoice Number', 'Invoice Date', 'AWB Number', 'Currency', 'Invoice Total', 'Document Type', 'VAT Extraction', 'Duty VAT', 'Handling VAT', 'Total VAT', 'Reason', 'Source File', 'Status'],
    files: ['File', 'SHA-256', 'Document Type', 'Pages', 'Extraction Method', 'Duplicate Of', 'Status'],
    FedEx_Invoice_Check: ['Vendor Name', 'Invoice Number', 'Invoice Date', 'AWB Number', 'Currency', 'Invoice Total', 'Document Type', 'VAT Extraction', 'Duty VAT', 'Handling VAT', 'Total VAT', 'Reason', 'Source File', 'Status'],
    File_Index: ['File', 'SHA-256', 'Document Type', 'Pages', 'Extraction Method', 'Duplicate Of', 'Status'],
  };
  if (presets[fallback]) return presets[fallback];
  if (!rows.length) return [];
  return Object.keys(rows[0]);
}

function fedexStats() {
  const total = countFedExFiles(STATE.fedexChecks);
  const duty = countFedExFiles(STATE.fedexChecks.filter(row => row['Document Type'] === 'DUTY'));
  const freight = countFedExFiles(STATE.fedexChecks.filter(row => row['Document Type'] === 'FREIGHT'));
  const unknown = countFedExFiles(STATE.fedexChecks.filter(row => row['Document Type'] === 'UNKNOWN'));
  const duplicate = countFedExFiles(STATE.fedexChecks.filter(row => row['Document Type'] === 'DUPLICATE'));
  return { total, duty, freight, unknown, duplicate, valid: total === duty + freight + unknown + duplicate };
}

function countFedExFiles(rows) {
  return new Set(rows.map(row => row['Source File']).filter(Boolean)).size;
}

function sortedFedExChecks() {
  const order = { DUTY: 0, FREIGHT: 1, UNKNOWN: 2, DUPLICATE: 3 };
  return [...STATE.fedexChecks].sort((a, b) => {
    const aOrder = Object.prototype.hasOwnProperty.call(order, a['Document Type']) ? order[a['Document Type']] : 9;
    const bOrder = Object.prototype.hasOwnProperty.call(order, b['Document Type']) ? order[b['Document Type']] : 9;
    const typeDiff = aOrder - bOrder;
    if (typeDiff) return typeDiff;
    return String(a['Invoice Date'] || '').localeCompare(String(b['Invoice Date'] || '')) || String(a['Invoice Number'] || '').localeCompare(String(b['Invoice Number'] || ''));
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

function fedexAwbBlocks(text) {
  const matches = [...String(text || '').matchAll(/(?:선적일자\s*)?Ship\s*Date\s*[:：]?/gi)];
  if (!matches.length) return [];
  return matches.map((match, index) => {
    const next = matches[index + 1];
    return text.slice(match.index, next ? next.index : text.length);
  }).filter(block => /Air\s*Waybill\s*Number|\b\d{10,15}\b/i.test(block));
}

function sumAmountsForLabel(text, labelRe) {
  const values = [];
  const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    const sameLine = monetaryMatches(lines[i].replace(labelRe, ''));
    if (sameLine.length) {
      values.push(sameLine[sameLine.length - 1]);
      continue;
    }
    const nextLines = lines.slice(i + 1, i + 2).join(' ');
    const nextValues = monetaryMatches(nextLines);
    if (nextValues.length) values.push(nextValues[0]);
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function sumPresentAmounts(values) {
  const present = values.filter(value => value != null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : '';
}

function extractShipmentPeriod(text) {
  const period = firstMatch(text, [
    /(?:Shipment|Billing)\s*Period\s*[:：]?\s*([0-9A-Za-z.,/\-\s]+?\s*(?:to|-|~)\s*[0-9A-Za-z.,/\-\s]+)/i,
    /\b(\d{1,2}\/\d{1,2}\s*(?:-|~|to)\s*\d{1,2}\/\d{1,2})\b/i,
  ]);
  return period.replace(/\s+/g, ' ').trim();
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
    const month = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }[m[2].toLowerCase()];
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (month) return `${year}-${month}-${pad2(m[1])}`;
  }
  m = raw.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (m) {
    const month = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }[m[2].toLowerCase()];
    if (month) return `${m[3]}-${month}-${pad2(m[1])}`;
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
  STATE.fedexChecks = [];
  STATE.summaries = [];
  STATE.charges = [];
  STATE.reviews = [];
  STATE.activeTab = 'fedex';
  setActiveTabButton('fedex');
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

function isPotentialFedExFile(fileName) {
  return /fedex|federal\s*express/i.test(fileName);
}

function isFedExDocumentType(type) {
  return type === DOC_TYPES.FEDEX_DUTY || type === DOC_TYPES.FEDEX_FREIGHT || type === DOC_TYPES.FEDEX_UNKNOWN;
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
