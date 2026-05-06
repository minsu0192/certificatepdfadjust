/* ── CONFIG ──────────────────────────────────────────────────── */
const CONFIG = {
  PDFJS_WORKER_URL: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',

  REGEX: {
    // 신고번호: 5자리-2자리-숫자+알파벳 (예: 23176-26-197002M)
    DECL_NUMBER: /(\d{5}-\d{2}-\d+[A-Z]?)/g,

    // 신고일자: UNI-PASS 기본 형식 YYYY/MM/DD 우선, 그 외 형식 폴백
    DECL_DATE_SLASH:   /\b(\d{4})\/(\d{2})\/(\d{2})\b/,
    DECL_DATE_LABELED: /신고일자\s*[:：]?\s*(\d{4}[-./]\d{2}[-./]\d{2})/,
    DECL_DATE_COMPACT: /신고일자\s*[:：]?\s*(\d{8})/,
    DECL_DATE_FALLBACK:/\b(20\d{2})[-./](\d{2})[-./](\d{2})\b/,

    // 세번부호(HS코드): XXXX.XX-XXXX 형식
    HS_SEOBUN: /세번부호\s+([\d.]+[-][\d]+)/,
    HS_CODE_FORMATTED: /(\d{4}\.\d{2}-\d{4})/,

    // 금액 라인: 수량 단위 단가 합계 (UNI-PASS: "2 EA   1,454,727   2,909,454")
    AMOUNT_LINE: /([\d,]+)\s+(EA|KG|MT|PC|SET|BOX|CTN|PCS|L|G|TON|M|개|매|본|장|식|롤)\s+([\d,]+)\s+([\d,]+)/i,

    // 가짜 금액 라인 필터: 이 키워드가 있는 줄은 제외
    SKIP_LINE: /환급물량|세관기재란|신고인기재란|납부번호|총세액합계|부가가치세과표/,
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
  const fileInput   = document.getElementById('fileInput');

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

    // Y좌표 기준으로 줄을 복원 (UNI-PASS 표 레이아웃에 최적)
    const lineMap = new Map();
    for (const item of content.items) {
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y).push({ x: item.transform[4], str: item.str });
    }

    const lines = [...lineMap.entries()]
      .sort((a, b) => b[0] - a[0])  // Y 내림차순 (위→아래)
      .map(([, items]) =>
        items.sort((a, b) => a.x - b.x).map(i => i.str).join(' ')
      );

    fullText += lines.join('\n') + '\n---PAGE_BREAK---\n';
  }

  return fullText;
}

/* ── TEXT EXTRACTION ─────────────────────────────────────────── */

function extractFromText(rawText, fileName) {
  const rows  = [];
  const warns = [];

  const allMatches = [...rawText.matchAll(CONFIG.REGEX.DECL_NUMBER)];

  if (allMatches.length === 0) {
    warns.push(`${fileName}: 신고번호를 찾을 수 없음`);
    return { rows, warns };
  }

  // 신고번호 중복 제거: 동일 번호가 머리글·바닥글에 반복 등장하므로 첫 출현만 사용
  const seen = new Set();
  const uniqueMatches = allMatches.filter(m => {
    if (seen.has(m[1])) return false;
    seen.add(m[1]);
    return true;
  });

  const sections = uniqueMatches.map((m, idx) => ({
    declNumber: m[1],
    text: rawText.slice(m.index, uniqueMatches[idx + 1]?.index ?? rawText.length),
  }));

  for (const section of sections) {
    const declDate  = extractDeclarationDate(section.text);
    const declMonth = declDate ? declDate.slice(0, 7) : '';
    const vendor    = extractVendor(section.text);
    const items     = extractItemLines(section.text);

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
  // UNI-PASS 기본: YYYY/MM/DD (신고번호 바로 뒤 첫 번째 날짜)
  let m = text.match(CONFIG.REGEX.DECL_DATE_SLASH);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(CONFIG.REGEX.DECL_DATE_LABELED);
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
  const patterns = [
    // "수   입   자   리모와코리아 유한회사(" → 괄호 앞에서 멈춤
    /수\s*입\s*자\s+([^\n(（]+)/,
    // "(상호)   리모와코리아 유한회사"
    /\(상호\)\s+([^\n\s][^\n]+)/,
    // 납세의무자 (스페이스 삽입 포함)
    /납\s*세\s*의\s*무\s*자\s+([^\n(（]+)/,
    /납세의무자\s*[:：]?\s*([^\n(（]+)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const v = m[1].trim().replace(/\s{2,}/g, ' ');
      if (v.length >= 2) return v;
    }
  }
  return '(알 수 없음)';
}

function extractItemName(text) {
  // 필드 31 (거래품명) 우선
  const m31 = text.match(/3\s*1\s+([A-Z][A-Z0-9 ]{2,}?)(?=\s{3,}|\n|거래품명)/);
  if (m31) return m31[1].trim();

  // 필드 30 (품명)
  const m30 = text.match(/3\s*0\s+([A-Z][A-Z0-9 ]{2,}?)(?=\s{3,}|\n)/);
  if (m30) return m30[1].trim();

  return '';
}

function extractItemLines(text) {
  const items = [];
  const lines = text.split(/\n|\r\n?/);

  // 전역 품목명 (필드 30/31) — 단일 품목 신고 시 사용
  const globalItemName = extractItemName(text);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // 환급물량, 세액 합계 등 가짜 EA 라인 제외
    if (CONFIG.REGEX.SKIP_LINE.test(line)) continue;

    const amtMatch = line.match(CONFIG.REGEX.AMOUNT_LINE);
    if (!amtMatch) continue;

    const qty       = parseKoreanNumber(amtMatch[1]);
    const unitPrice = parseKoreanNumber(amtMatch[3]);
    const total     = parseKoreanNumber(amtMatch[4]);

    // 실제 품목 금액은 최소 1,000원 이상 (환급물량 등 필드값 걸러냄)
    if (total < 1000) continue;

    // 같은 줄에서 품목 설명 추출: 수량 앞 텍스트 → 카탈로그 번호 제거
    const amtIdx = line.search(/\d[\d,]*\s+(EA|KG|MT|PC|SET|BOX|CTN|PCS)/i);
    let itemDesc = '';
    if (amtIdx > 0) {
      itemDesc = line.slice(0, amtIdx)
        .replace(/^[\d.\s]+/, '')  // 앞에 붙은 카탈로그/랏 번호 제거 (예: 973.90.04.2.0.0)
        .trim();
    }

    // HS코드(세번부호): UNI-PASS는 금액 라인 아래에 위치 → 앞으로 탐색
    let hsCode = '';
    for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
      const seobunM = lines[j].match(CONFIG.REGEX.HS_SEOBUN);
      if (seobunM) {
        hsCode = seobunM[1].replace(/[.\-]/g, '').slice(0, 10);
        break;
      }
      // XXXX.XX-XXXX 형식이 세번부호 문맥에서 등장
      const hsM = lines[j].match(CONFIG.REGEX.HS_CODE_FORMATTED);
      if (hsM && /3\s*8|세번/.test(lines[j])) {
        hsCode = hsM[1].replace(/[.\-]/g, '').slice(0, 10);
        break;
      }
    }

    items.push({
      hsCode,
      itemName:    itemDesc || globalItemName,
      quantity:    qty,
      unitPrice,
      totalAmount: total,
    });
  }

  return items;
}

function parseKoreanNumber(str) {
  return parseInt(str.replace(/,/g, ''), 10) || 0;
}

/* ── PROCESSING ORCHESTRATOR ─────────────────────────────────── */

async function processFiles(files) {
  STATE.rows     = [];
  STATE.warnings = [];
  STATE.fileCount = files.length;

  const zone = document.getElementById('dropZone');
  zone.classList.add('drop-zone--loading');

  showSection('progressSection', true);
  showSection('summaryStats',    false);
  showSection('actionBar',       false);
  showSection('tableSection',    false);

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

    await new Promise(r => setTimeout(r, 0));
  }

  // 추출 실패 시 디버그 패널 표시
  if (STATE.rows.length === 0 && firstPdfText) {
    const debugPanel = document.getElementById('debugPanel');
    document.getElementById('debugText').value = firstPdfText.slice(0, 3000);
    debugPanel.hidden = false;
    debugPanel.open   = true;
  }

  setProgress(files.length, files.length, `완료: ${files.length}개 파일 처리됨`);

  renderTable(STATE.rows);
  renderSummaryStats();
  renderWarnings(STATE.warnings);

  showSection('summaryStats', true);
  showSection('actionBar',    true);
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
  const list    = document.getElementById('warningsList');
  const badge   = document.getElementById('warningCount');

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
      { t: 's', v: r.hsCode },   // 텍스트 강제 (과학적 표기 방지)
      r.itemName,
      r.quantity,
      r.unitPrice,
      r.totalAmount,
    ]),
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
  ws1['!cols'] = [
    { wch: 20 }, { wch: 12 }, { wch: 25 }, { wch: 14 },
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
  ws2['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 25 }, { wch: 16 }];
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
  STATE.rows     = [];
  STATE.warnings = [];
  STATE.fileCount = 0;

  document.getElementById('resultsBody').innerHTML = '';
  document.getElementById('resultsFoot').innerHTML = '';
  document.getElementById('warningsList').innerHTML = '';

  showSection('summaryStats',   false);
  showSection('actionBar',      false);
  showSection('tableSection',   false);
  showSection('progressSection',false);
  showSection('warningsDetails',false);

  document.getElementById('dropZone').classList.remove(
    'drop-zone--loading', 'drop-zone--active', 'drop-zone--hover'
  );
  const debugPanel = document.getElementById('debugPanel');
  debugPanel.hidden = true;
  debugPanel.open   = false;
  document.getElementById('debugText').value = '';
}
