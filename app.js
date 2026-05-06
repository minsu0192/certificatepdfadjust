/* ── CONFIG ──────────────────────────────────────────────────── */
const CONFIG = {
  PDFJS_WORKER_URL: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',

  REGEX: {
    // 신고번호: 5자리-2자리-7자리 (UNI-PASS 표준)
    DECL_NUMBER: /(\d{5}-\d{2}-\d{7})/g,

    // 신고일자: 레이블 뒤 날짜 (전각 콜론 포함)
    DECL_DATE_LABELED: /신고일자\s*[:：]?\s*(\d{4}[-./]\d{2}[-./]\d{2})/,
    DECL_DATE_COMPACT: /신고일자\s*[:：]?\s*(\d{8})/,
    DECL_DATE_FALLBACK: /\b(20\d{2})[-./](\d{2})[-./](\d{2})\b/,

    // 거래처: 납세의무자 → 거래처 → 공급자 순으로 시도
    VENDOR_PATTERNS: [
      /납세의무자\s*[:：]?\s*([^\n\r\t]{2,50})/,
      /거래처\s*[:：]?\s*([^\n\r\t]{2,50})/,
      /공급자\s*[:：]?\s*([^\n\r\t]{2,50})/,
    ],

    // HS코드: 10자리 숫자 또는 XXXX.XX-XXXX 형식
    HS_CODE: /\b(\d{10})\b|(\d{4}\.\d{2}-\d{4})/,
    HS_CODE_FORMATTED: /(\d{4}\.\d{2}-\d{4})/,

    // 금액 라인: 수량 단위 단가 합계
    AMOUNT_LINE: /([\d,]+)\s+(EA|KG|MT|PC|SET|BOX|CTN|L|M|개|매|본|장|식|롤|PCS|G|TON)\s+([\d,]+)\s+([\d,]+)/i,
  },

  EXPORT_FILENAME() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `수입신고필증_집계_${y}${m}${day}.xlsx`;
  },
};

/* ── STATE ───────────────────────────────────────────────────── */
const STATE = {
  rows: [],
  warnings: [],
  fileCount: 0,
};

/* ── INIT ────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  if (!checkLibraries()) return;
  setupDropZone();
  setupFileInputs();
  document.getElementById('btnExcel').addEventListener('click', exportExcel);
  document.getElementById('btnReset').addEventListener('click', resetApp);
});

function checkLibraries() {
  const pdfOk = typeof pdfjsLib !== 'undefined';
  const xlsxOk = typeof XLSX !== 'undefined';
  if (!pdfOk || !xlsxOk) {
    document.getElementById('cdnError').hidden = false;
    return false;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = CONFIG.PDFJS_WORKER_URL;
  return true;
}

/* ── FILE COLLECTION ─────────────────────────────────────────── */

function setupDropZone() {
  const zone = document.getElementById('dropZone');

  zone.addEventListener('click', () => document.getElementById('fileInput').click());

  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    zone.classList.add('drop-zone--hover');
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drop-zone--active');
    zone.classList.remove('drop-zone--hover');
  });

  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) {
      zone.classList.remove('drop-zone--hover', 'drop-zone--active');
    }
  });

  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('drop-zone--hover', 'drop-zone--active');
    const files = await collectPdfFiles(e.dataTransfer);
    if (files.length > 0) processFiles(files);
  });
}

function setupFileInputs() {
  const folderInput = document.getElementById('folderInput');
  const fileInput = document.getElementById('fileInput');

  document.getElementById('btnSelectFolder').addEventListener('click', (e) => {
    e.stopPropagation();
    folderInput.click();
  });

  document.getElementById('btnSelectFiles').addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  folderInput.addEventListener('change', () => {
    const files = [...folderInput.files].filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) processFiles(files);
    folderInput.value = '';
  });

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files].filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) processFiles(files);
    fileInput.value = '';
  });
}

async function getFilesFromEntry(entry) {
  if (entry.isFile) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();
    const allFiles = [];

    const readBatch = () => new Promise((resolve, reject) => {
      reader.readEntries(async (entries) => {
        if (entries.length === 0) { resolve(); return; }
        for (const e of entries) {
          const result = await getFilesFromEntry(e);
          if (Array.isArray(result)) allFiles.push(...result);
          else allFiles.push(result);
        }
        readBatch().then(resolve).catch(reject);
      }, reject);
    });

    await readBatch();
    return allFiles;
  }

  return [];
}

async function collectPdfFiles(dataTransfer) {
  const files = [];

  if (dataTransfer.items && dataTransfer.items.length > 0) {
    for (const item of dataTransfer.items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (!entry) {
        const f = item.getAsFile();
        if (f && f.name.toLowerCase().endsWith('.pdf')) files.push(f);
        continue;
      }
      const result = await getFilesFromEntry(entry);
      const arr = Array.isArray(result) ? result : [result];
      files.push(...arr.filter(f => f.name.toLowerCase().endsWith('.pdf')));
    }
  } else {
    for (const f of dataTransfer.files) {
      if (f.name.toLowerCase().endsWith('.pdf')) files.push(f);
    }
  }

  return files;
}

/* ── PDF PARSING ─────────────────────────────────────────────── */

async function parsePdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const simpleText = content.items.map(item => item.str).join(' ');

    // 금액 라인이 없으면 공간 정렬 폴백
    if (!CONFIG.REGEX.AMOUNT_LINE.test(simpleText)) {
      const sorted = [...content.items].sort((a, b) => {
        const yA = Math.round(b.transform[5] / 4) * 4;
        const yB = Math.round(a.transform[5] / 4) * 4;
        if (yA !== yB) return yA - yB;
        return a.transform[4] - b.transform[4];
      });
      fullText += sorted.map(i => i.str).join(' ') + '\n';
    } else {
      // 줄 단위로 복원: Y좌표 기준 그룹핑
      const lineMap = new Map();
      for (const item of content.items) {
        const y = Math.round(item.transform[5] / 2) * 2;
        if (!lineMap.has(y)) lineMap.set(y, []);
        lineMap.get(y).push({ x: item.transform[4], str: item.str });
      }
      const lines = [...lineMap.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) =>
          items.sort((a, b) => a.x - b.x).map(i => i.str).join(' ')
        );
      fullText += lines.join('\n') + '\n';
    }

    fullText += '---PAGE_BREAK---\n';
  }

  return fullText;
}

/* ── TEXT EXTRACTION ─────────────────────────────────────────── */

function extractFromText(rawText, fileName) {
  const rows = [];
  const warns = [];

  const declMatches = [...rawText.matchAll(CONFIG.REGEX.DECL_NUMBER)];

  if (declMatches.length === 0) {
    warns.push(`${fileName}: 신고번호를 찾을 수 없음`);
    return { rows, warns };
  }

  // 신고번호를 앵커로 텍스트를 구간 분리
  const sections = declMatches.map((m, idx) => {
    const start = m.index;
    const end = declMatches[idx + 1]?.index ?? rawText.length;
    return { declNumber: m[1], text: rawText.slice(start, end) };
  });

  for (const section of sections) {
    const declDate = extractDeclarationDate(section.text);
    const declMonth = declDate ? declDate.slice(0, 7) : '';
    const vendor = extractVendor(section.text);
    const items = extractItemLines(section.text);

    if (items.length === 0) {
      warns.push(`${fileName} / ${section.declNumber}: 품목 라인을 찾을 수 없음`);
    }

    for (const item of items) {
      rows.push({
        fileName,
        declNumber:  section.declNumber,
        declDate,
        declMonth,
        vendor,
        hsCode:      item.hsCode,
        itemName:    item.itemName,
        quantity:    item.quantity,
        unitPrice:   item.unitPrice,
        totalAmount: item.totalAmount,
      });
    }
  }

  return { rows, warns };
}

function extractDeclarationDate(text) {
  let m = text.match(CONFIG.REGEX.DECL_DATE_LABELED);
  if (m) return m[1].replace(/[./]/g, '-');

  m = text.match(CONFIG.REGEX.DECL_DATE_COMPACT);
  if (m) {
    const s = m[1];
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  m = text.match(CONFIG.REGEX.DECL_DATE_FALLBACK);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  return '';
}

function extractVendor(text) {
  for (const re of CONFIG.REGEX.VENDOR_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1].trim().replace(/\s{2,}/g, ' ');
  }
  return '(알 수 없음)';
}

function extractItemLines(text) {
  const items = [];
  const lines = text.split(/\n|\r\n?/);

  let pendingHsCode = '';
  let pendingItemName = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // HS코드 탐지
    const hsFormatted = trimmed.match(CONFIG.REGEX.HS_CODE_FORMATTED);
    const hsBare = trimmed.match(/\b(\d{10})\b/);

    if (hsFormatted || hsBare) {
      const rawCode = hsFormatted ? hsFormatted[1] : hsBare[1];
      pendingHsCode = rawCode.replace(/[.\-]/g, '').slice(0, 10);

      const matchPos = (hsFormatted || hsBare).index;
      const rawBefore = trimmed.slice(0, matchPos).trim();
      // "품목 N" 접두어 제거
      pendingItemName = rawBefore.replace(/^품목\s*\d+\s*/i, '').trim();
    }

    // 금액 라인 탐지
    const amtMatch = trimmed.match(CONFIG.REGEX.AMOUNT_LINE);
    if (amtMatch) {
      items.push({
        hsCode:      pendingHsCode || '',
        itemName:    pendingItemName || '',
        quantity:    parseKoreanNumber(amtMatch[1]),
        unitPrice:   parseKoreanNumber(amtMatch[3]),
        totalAmount: parseKoreanNumber(amtMatch[4]),
      });
      pendingHsCode = '';
      pendingItemName = '';
    }
  }

  return items;
}

function parseKoreanNumber(str) {
  return parseInt(str.replace(/,/g, ''), 10) || 0;
}

/* ── PROCESSING ORCHESTRATOR ─────────────────────────────────── */

async function processFiles(files) {
  STATE.rows = [];
  STATE.warnings = [];
  STATE.fileCount = files.length;

  const zone = document.getElementById('dropZone');
  zone.classList.add('drop-zone--loading');

  showSection('progressSection', true);
  showSection('summaryStats', false);
  showSection('actionBar', false);
  showSection('tableSection', false);

  let firstPdfText = null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    setProgress(i, files.length, `처리 중 (${i + 1}/${files.length}): ${file.name}`);

    try {
      const text = await parsePdf(file);
      if (i === 0) firstPdfText = text;
      const { rows, warns } = extractFromText(text, file.name);
      STATE.rows.push(...rows);
      STATE.warnings.push(...warns);
    } catch (err) {
      STATE.warnings.push(`${file.name}: 파싱 오류 — ${err.message}`);
    }

    // 브라우저 렌더링에 양보
    await new Promise(r => setTimeout(r, 0));
  }

  // 추출 실패 시 디버그 패널 표시
  if (STATE.rows.length === 0 && firstPdfText) {
    const debugPanel = document.getElementById('debugPanel');
    document.getElementById('debugText').value = firstPdfText.slice(0, 3000);
    debugPanel.hidden = false;
    debugPanel.open = true;
  }

  setProgress(files.length, files.length, `완료: ${files.length}개 파일 처리됨`);

  renderTable(STATE.rows);
  renderSummaryStats();
  renderWarnings(STATE.warnings);

  showSection('summaryStats', true);
  showSection('actionBar', true);
  showSection('tableSection', true);

  zone.classList.remove('drop-zone--loading');
  setTimeout(() => showSection('progressSection', false), 1500);
}

/* ── RENDER ──────────────────────────────────────────────────── */

function renderTable(rows) {
  const tbody = document.getElementById('resultsBody');
  const tfoot = document.getElementById('resultsFoot');

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--color-text-muted);padding:24px;">추출된 데이터가 없습니다</td></tr>';
    tfoot.innerHTML = '';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="decl-number">${escHtml(r.declNumber)}</td>
      <td>${escHtml(r.declDate)}</td>
      <td>${escHtml(r.vendor)}</td>
      <td class="code">${escHtml(r.hsCode)}</td>
      <td>${escHtml(r.itemName)}</td>
      <td class="num">${formatNumber(r.quantity)}</td>
      <td class="num">${formatNumber(r.unitPrice)}</td>
      <td class="num">${formatNumber(r.totalAmount)}</td>
    </tr>
  `).join('');

  const grandTotal = rows.reduce((s, r) => s + r.totalAmount, 0);
  tfoot.innerHTML = `
    <tr>
      <td colspan="5" style="font-family:var(--font-body);font-size:0.85rem;">합계</td>
      <td class="num"></td>
      <td class="num"></td>
      <td class="num">${formatNumber(grandTotal)}</td>
    </tr>
  `;
}

function renderSummaryStats() {
  const grandTotal = STATE.rows.reduce((s, r) => s + r.totalAmount, 0);
  document.getElementById('statFiles').textContent = STATE.fileCount;
  document.getElementById('statItems').textContent = STATE.rows.length;
  document.getElementById('statTotal').textContent = formatNumber(grandTotal);
}

function renderWarnings(warnings) {
  const details = document.getElementById('warningsDetails');
  const list = document.getElementById('warningsList');
  const badge = document.getElementById('warningCount');

  if (warnings.length === 0) {
    details.hidden = true;
    return;
  }

  badge.textContent = warnings.length;
  list.innerHTML = warnings.map(w => `<li>${escHtml(w)}</li>`).join('');
  details.hidden = false;
}

/* ── EXCEL EXPORT ────────────────────────────────────────────── */

function exportExcel() {
  if (STATE.rows.length === 0) return;

  const wb = XLSX.utils.book_new();

  // Sheet 1: 원본
  const sheet1Data = [
    ['신고번호', '신고일자', '거래처', 'HS코드', '품목명', '수량', '단가', '합계금액'],
    ...STATE.rows.map(r => [
      r.declNumber,
      r.declDate,
      r.vendor,
      { t: 's', v: r.hsCode },  // HS코드는 텍스트 강제 (과학적 표기 방지)
      r.itemName,
      r.quantity,
      r.unitPrice,
      r.totalAmount,
    ]),
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
  ws1['!cols'] = [
    { wch: 18 }, { wch: 12 }, { wch: 25 }, { wch: 14 },
    { wch: 35 }, { wch: 10 }, { wch: 14 }, { wch: 16 },
  ];
  applyNumberFormat(ws1, sheet1Data.length, [5, 6, 7], '#,##0');
  XLSX.utils.book_append_sheet(wb, ws1, '원본');

  // Sheet 2: 신고번호별
  const byDecl = groupAndSum(STATE.rows, 'declNumber', ['declDate', 'vendor']);
  const sheet2Data = [
    ['신고번호', '신고일자', '거래처', '합계금액'],
    ...byDecl.map(g => [g.key, g.declDate, g.vendor, g.sum]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(sheet2Data);
  ws2['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 25 }, { wch: 16 }];
  applyNumberFormat(ws2, sheet2Data.length, [3], '#,##0');
  XLSX.utils.book_append_sheet(wb, ws2, '신고번호별');

  // Sheet 3: 월별
  const byMonth = groupAndSum(STATE.rows, 'declMonth', []);
  const sheet3Data = [
    ['월', '합계금액'],
    ...byMonth.map(g => [g.key, g.sum]),
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(sheet3Data);
  ws3['!cols'] = [{ wch: 10 }, { wch: 16 }];
  applyNumberFormat(ws3, sheet3Data.length, [1], '#,##0');
  XLSX.utils.book_append_sheet(wb, ws3, '월별');

  XLSX.writeFile(wb, CONFIG.EXPORT_FILENAME());
}

function groupAndSum(rows, keyField, extraFields) {
  const map = new Map();
  for (const row of rows) {
    const k = row[keyField] || '(없음)';
    if (!map.has(k)) {
      const entry = { key: k, sum: 0 };
      for (const f of extraFields) entry[f] = row[f] ?? '';
      map.set(k, entry);
    }
    map.get(k).sum += row.totalAmount;
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function applyNumberFormat(ws, rowCount, colIndices, fmt) {
  for (let r = 1; r < rowCount; r++) {
    for (const c of colIndices) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr]) ws[addr].z = fmt;
    }
  }
}

/* ── UTILITIES ───────────────────────────────────────────────── */

function formatNumber(n) {
  if (n === null || n === undefined || isNaN(n)) return '';
  return n.toLocaleString('ko-KR');
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setProgress(current, total, label) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const bar = document.getElementById('progressBar');
  bar.style.width = pct + '%';
  bar.setAttribute('aria-valuenow', pct);
  document.getElementById('progressLabel').textContent = label;
}

function showSection(id, visible) {
  document.getElementById(id).hidden = !visible;
}

function resetApp() {
  STATE.rows = [];
  STATE.warnings = [];
  STATE.fileCount = 0;

  document.getElementById('resultsBody').innerHTML = '';
  document.getElementById('resultsFoot').innerHTML = '';
  document.getElementById('warningsList').innerHTML = '';

  showSection('summaryStats', false);
  showSection('actionBar', false);
  showSection('tableSection', false);
  showSection('progressSection', false);
  showSection('warningsDetails', false);

  document.getElementById('dropZone').classList.remove('drop-zone--loading', 'drop-zone--active', 'drop-zone--hover');
  const debugPanel = document.getElementById('debugPanel');
  debugPanel.hidden = true;
  debugPanel.open = false;
  document.getElementById('debugText').value = '';
}
