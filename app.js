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

    // 금액 라인: 수량 단위 단가 합계
    // 단위: UNI-PASS 표준 전체 포함 (ST=piece, RO=roll, PR=pair 등)
    // 금액: 소수점 허용 (예: 7,614.29 / 76,142.9)
    AMOUNT_LINE: /([\d,]+)\s+(EA|KG|MT|PC|SET|BOX|CTN|PCS|ST|RO|NO|PR|PKG|BT|DZ|M2|M3|L|G|TON|M|개|매|본|장|식|롤)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)/i,

    // 외화 금액 라인: 수량 단위 단가 [통화코드] 합계 (예: 2 EA 727.36 USD 1,454.72)
    AMOUNT_LINE_WITH_CURR: /([\d,]+)\s+(EA|KG|MT|PC|SET|BOX|CTN|PCS|ST|RO|NO|PR|PKG|BT|DZ|M2|M3|L|G|TON|M|개|매|본|장|식|롤)\s+([\d,]+(?:\.\d+)?)\s+(USD|EUR|JPY|GBP|CNY|CHF|HKD|SGD|AUD|CAD|NZD|SEK|NOK|DKK|MYR|THB|INR|VND|IDR|PHP|BRL|RUB|TWD|KWD|SAR|AED|TRY)\s+([\d,]+(?:\.\d+)?)/i,

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

const FOREIGN_CURRENCIES = new Set([
  'USD','EUR','JPY','GBP','CNY','CHF','HKD','SGD','AUD','CAD',
  'NZD','SEK','NOK','DKK','MYR','THB','INR','VND','IDR','PHP',
  'BRL','RUB','TWD','KWD','SAR','AED','TRY',
]);

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

  // PDF 1개 = 신고서 1개: 본문에 등장하는 첫 번째 신고번호만 사용
  // (바닥글·참조 번호 중복 방지)
  const firstMatch = rawText.match(/(\d{5}-\d{2}-\d+[A-Z]?)/);
  if (!firstMatch) {
    warns.push(`${fileName}: 신고번호를 찾을 수 없음`);
    return { rows, warns };
  }

  const declNumber = firstMatch[1].replace(/-/g, '');
  const declDate   = extractDeclarationDate(rawText);
  const declMonth  = declDate ? declDate.slice(0, 7) : '';
  const vendor     = extractVendor(rawText);
  const declCurrency = extractCurrency(rawText);
  // 디버그: 통화 감지 결과 및 헤더 텍스트 콘솔 출력
  console.log(`[currency] ${fileName}: ${declCurrency}`);
  if (declCurrency === 'KRW') {
    // KRW로 감지된 경우 앞 3000자를 출력해서 실제 통화 코드 위치 확인
    console.log(`[currency-debug] ${fileName} header:`, rawText.slice(0, 3000));
  }
  const items      = extractItemLines(rawText);

  if (items.length === 0) {
    warns.push(`${fileName} / ${declNumber}: 품목 라인을 찾을 수 없음`);
  }

  for (const item of items) {
    rows.push({
      fileName,
      declNumber,
      declDate,
      declMonth,
      vendor,
      hsCode:      item.hsCode,
      itemName:    item.itemName,
      quantity:    item.quantity,
      unitPrice:   item.unitPrice,
      totalAmount: item.totalAmount,
      currency:    item.currency || declCurrency,
    });
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

function extractCurrency(text) {
  const CURR = 'USD|EUR|JPY|GBP|CNY|CHF|HKD|SGD|AUD|CAD|NZD|SEK|NOK|DKK|MYR|THB|INR|VND|IDR|PHP|BRL|RUB|TWD|KWD|SAR|AED|TRY';

  // 결제금액 필드: 스페이스 삽입·개행 모두 허용 (결 제 금 액   \n  USD)
  let m = text.match(new RegExp(`결\\s*제\\s*금\\s*액[\\s\\S]{0,40}(${CURR})`));
  if (m && FOREIGN_CURRENCIES.has(m[1])) return m[1];

  // 통화 필드 (개행 허용)
  m = text.match(new RegExp(`통\\s*화[\\s\\S]{0,20}(${CURR})`));
  if (m && FOREIGN_CURRENCIES.has(m[1])) return m[1];

  // 가격조건: CIF USD / FOB EUR 등
  m = text.match(new RegExp(`(?:CIF|FOB|CFR|CPT|DAP|DDP|EXW)[\\s\\S]{0,15}(${CURR})`));
  if (m && FOREIGN_CURRENCIES.has(m[1])) return m[1];

  // 외화금액 필드
  m = text.match(new RegExp(`외\\s*화\\s*금\\s*액[\\s\\S]{0,30}(${CURR})`));
  if (m && FOREIGN_CURRENCIES.has(m[1])) return m[1];

  // 폭넓은 폴백: 문서 앞 3000자(헤더) 내 단독 외화 코드
  // 신고필증 헤더에는 결제금액·가격조건 등이 존재하므로 통화 코드가 반드시 등장
  const header = text.slice(0, 3000);
  m = header.match(new RegExp(`\\b(${CURR})\\b`));
  if (m && FOREIGN_CURRENCIES.has(m[1])) return m[1];

  return 'KRW';
}

function extractItemName(text) {
  // 새 형식: "3 1   거래품명   ITEM NAME" (소모품·부품류)
  const m31new = text.match(/3\s*1\s+거래품명\s+([^\n\r]+)/);
  if (m31new) return m31new[1].trim();

  // 구 형식: "3 1   ITEM NAME" → 다음 줄에 "거래품명" (완제품류)
  const m31old = text.match(/3\s*1\s+([A-Z][A-Z0-9 ]{2,}?)(?=\s{3,}|\n|거래품명)/);
  if (m31old) return m31old[1].trim();

  // 필드 30: 품명 (상표 레이블 앞까지만)
  const m30 = text.match(/3\s*0\s+품\s*명\s+([A-Z][^\n\r]+?)(?=\s{3,}|상표|\n)/);
  if (m30) return m30[1].trim();

  const m30b = text.match(/3\s*0\s+([A-Z][A-Z0-9 ]{2,}?)(?=\s{3,}|\n)/);
  if (m30b) return m30b[1].trim();

  return '';
}

function extractItemLines(text) {
  const items = [];
  const globalItemName = extractItemName(text);

  // UNI-PASS는 각 품목 앞에 (NO. 01) (NO. 02) ... 마커를 둠.
  // 라인 분리 없이 원문에서 직접 청크를 잘라 파싱 → Y좌표 오정렬 문제 우회.
  const noMatches = [...text.matchAll(/\(NO\.\s*\d+\)/gi)];

  if (noMatches.length > 0) {
    for (const noMatch of noMatches) {
      // (NO. XX) 이후 600자 안에서 금액 패턴 탐색
      const chunkStart = noMatch.index + noMatch[0].length;
      const chunk = text.slice(chunkStart, chunkStart + 600);

      let amtMatch = chunk.match(CONFIG.REGEX.AMOUNT_LINE_WITH_CURR);
      let itemCurrency = null;
      let qty, unitPrice, total;

      if (amtMatch) {
        itemCurrency = amtMatch[4].toUpperCase();
        qty       = parseKoreanNumber(amtMatch[1]);
        unitPrice = parseKoreanNumber(amtMatch[3]);
        total     = parseKoreanNumber(amtMatch[5]);
      } else {
        amtMatch = chunk.match(CONFIG.REGEX.AMOUNT_LINE);
        if (!amtMatch) continue;
        qty       = parseKoreanNumber(amtMatch[1]);
        unitPrice = parseKoreanNumber(amtMatch[3]);
        total     = parseKoreanNumber(amtMatch[4]);
      }
      // (NO. XX) 앵커 기반은 소액도 허용 (부품류: 400원, 214원 등 실제 존재)
      if (unitPrice === 0 && total === 0) continue;

      // 품목 설명 추출
      const amtIdx = chunk.search(itemCurrency ? CONFIG.REGEX.AMOUNT_LINE_WITH_CURR : CONFIG.REGEX.AMOUNT_LINE);
      let itemDesc = '';
      if (amtIdx > 0) {
        // 수량 앞 텍스트: 줄바꿈 제거 후 앞의 품목코드(숫자)·국가코드(2자리 대문자) 정리
        const beforeAmt = chunk.slice(0, amtIdx).replace(/[\n\r]+/g, ' ').trim();
        const cleaned = beforeAmt
          .replace(/^\d+\s*/, '')          // 앞 품목코드 제거
          .replace(/\s+[A-Z]{2}\s*$/, '')  // 뒤 국가코드(DE, CZ 등) 제거
          .trim();
        if (cleaned.length >= 2) {
          itemDesc = cleaned;
        } else {
          // Format B: 설명이 금액 라인 다음 줄에 있음
          const afterAmt = chunk.slice(amtIdx + amtMatch[0].length, amtIdx + amtMatch[0].length + 120);
          const nextLine = afterAmt.split(/\n/)[1] || '';
          const nextCleaned = nextLine.replace(/^\d+\s*/, '').trim();
          if (nextCleaned.length >= 2) itemDesc = nextCleaned;
        }
      }

      // HS코드: 금액 이후 800자 내 세번부호 탐색
      const afterStart = chunkStart + amtIdx + amtMatch[0].length;
      const afterChunk = text.slice(afterStart, afterStart + 800);
      let hsCode = '';
      const seobunM = afterChunk.match(CONFIG.REGEX.HS_SEOBUN);
      if (seobunM) hsCode = seobunM[1].replace(/[.\-]/g, '').slice(0, 10);

      items.push({
        hsCode,
        itemName:    itemDesc || globalItemName,
        quantity:    qty,
        unitPrice,
        totalAmount: total,
        currency:    itemCurrency,
      });
    }
  }

  // (NO. XX) 마커가 없는 비표준 형식 폴백: 줄별 파싱
  if (items.length === 0) {
    const lines = text.split(/\n|\r\n?/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || CONFIG.REGEX.SKIP_LINE.test(line)) continue;

      let amtMatch = line.match(CONFIG.REGEX.AMOUNT_LINE_WITH_CURR);
      let lineCurrency = null;
      let qty, unitPrice, total;

      if (amtMatch) {
        lineCurrency = amtMatch[4].toUpperCase();
        qty       = parseKoreanNumber(amtMatch[1]);
        unitPrice = parseKoreanNumber(amtMatch[3]);
        total     = parseKoreanNumber(amtMatch[5]);
      } else {
        amtMatch = line.match(CONFIG.REGEX.AMOUNT_LINE);
        if (!amtMatch) continue;
        qty       = parseKoreanNumber(amtMatch[1]);
        unitPrice = parseKoreanNumber(amtMatch[3]);
        total     = parseKoreanNumber(amtMatch[4]);
      }
      if (!lineCurrency && total < 1000) continue;

      const amtIdx = line.search(lineCurrency ? CONFIG.REGEX.AMOUNT_LINE_WITH_CURR : CONFIG.REGEX.AMOUNT_LINE);
      const itemDesc = amtIdx > 0
        ? line.slice(0, amtIdx).replace(/^[\d.\s]+/, '').trim()
        : '';

      let hsCode = '';
      for (let k = i + 1; k < Math.min(i + 25, lines.length); k++) {
        const seobunM = lines[k].match(CONFIG.REGEX.HS_SEOBUN);
        if (seobunM) { hsCode = seobunM[1].replace(/[.\-]/g, '').slice(0, 10); break; }
      }

      items.push({ hsCode, itemName: itemDesc || globalItemName, quantity: qty, unitPrice, totalAmount: total, currency: lineCurrency });
    }
  }

  return items;
}

function parseKoreanNumber(str) {
  // 소수점 포함 금액(예: 76,142.9) 지원 → 반올림하여 정수화
  const n = parseFloat(str.replace(/,/g, ''));
  return isNaN(n) ? 0 : Math.round(n);
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

  let firstFailingText = null;
  let firstFailingName = '';

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    setProgress(i, files.length, `처리 중 (${i + 1}/${files.length}): ${file.name}`);

    try {
      const text = await parsePdf(file);
      const { rows, warns } = extractFromText(text, file.name);
      STATE.rows.push(...rows);
      STATE.warnings.push(...warns);
      // 품목 라인을 못 찾은 파일의 텍스트 저장 (디버그용)
      if (rows.length === 0 && !firstFailingText) {
        firstFailingText = text;
        firstFailingName = file.name;
      }
    } catch (err) {
      STATE.warnings.push(`${file.name}: 파싱 오류 — ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 0));
  }

  // 실패한 파일이 있으면 디버그 패널 표시
  if (firstFailingText) {
    const debugPanel = document.getElementById('debugPanel');
    const summary = document.querySelector('#debugPanel > summary');
    if (summary) summary.textContent = `🔍 파싱 실패 파일 원문: ${firstFailingName}`;
    document.getElementById('debugText').value = firstFailingText.slice(0, 4000);
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

  tbody.innerHTML = rows.map(r => {
    const isForeign = r.currency && r.currency !== 'KRW';
    return `
    <tr>
      <td class="decl-number">${escHtml(r.declNumber)}</td>
      <td>${escHtml(r.declDate)}</td>
      <td>${escHtml(r.vendor)}</td>
      <td class="code">${escHtml(r.hsCode)}</td>
      <td>${escHtml(r.itemName)}</td>
      <td class="num">${formatNumber(r.quantity)}</td>
      <td class="num">${formatNumber(r.unitPrice)}</td>
      <td class="currency-cell"><span class="currency-tag ${isForeign ? 'currency-tag--foreign' : 'currency-tag--krw'}">${escHtml(r.currency || 'KRW')}</span></td>
      <td class="num">${formatNumber(r.totalAmount)}</td>
    </tr>`;
  }).join('');

  const byCurrency = new Map();
  for (const r of rows) {
    const c = r.currency || 'KRW';
    byCurrency.set(c, (byCurrency.get(c) || 0) + r.totalAmount);
  }
  const currEntries = [...byCurrency.entries()].sort((a, b) =>
    a[0] === 'KRW' ? -1 : b[0] === 'KRW' ? 1 : a[0].localeCompare(b[0])
  );
  tfoot.innerHTML = currEntries.map(([curr, total], idx) => {
    const isForeign = curr !== 'KRW';
    return `
    <tr>
      <td colspan="5" style="font-family:var(--font-body);font-size:0.85rem;">${idx === 0 ? '합계' : ''}</td>
      <td class="num"></td>
      <td class="num"></td>
      <td class="currency-cell"><span class="currency-tag ${isForeign ? 'currency-tag--foreign' : 'currency-tag--krw'}">${escHtml(curr)}</span></td>
      <td class="num">${formatNumber(total)}</td>
    </tr>`;
  }).join('');
}

function renderSummaryStats() {
  document.getElementById('statFiles').textContent = STATE.fileCount;
  document.getElementById('statItems').textContent = STATE.rows.length;

  const byCurrency = new Map();
  for (const r of STATE.rows) {
    const c = r.currency || 'KRW';
    byCurrency.set(c, (byCurrency.get(c) || 0) + r.totalAmount);
  }

  const statTotal = document.getElementById('statTotal');
  const statUnit  = document.getElementById('statUnit');

  if (byCurrency.size === 0) {
    statTotal.textContent = '0';
    statUnit.textContent  = 'KRW';
    return;
  }

  if (byCurrency.size === 1) {
    const [[curr, total]] = [...byCurrency.entries()];
    statTotal.textContent = formatNumber(total);
    statUnit.textContent  = curr;
    return;
  }

  // 복수 통화: KRW 우선 표시
  const sorted = [...byCurrency.entries()].sort((a, b) =>
    a[0] === 'KRW' ? -1 : b[0] === 'KRW' ? 1 : a[0].localeCompare(b[0])
  );
  statTotal.innerHTML = sorted.map(([c, v], i) =>
    `<span style="display:block;font-size:${i === 0 ? '1.45rem' : '1rem'};line-height:1.3">${formatNumber(v)}</span>`
  ).join('');
  statUnit.innerHTML = sorted.map(([c], i) =>
    `<span style="display:block;font-size:${i === 0 ? '0.78rem' : '0.7rem'}">${escHtml(c)}</span>`
  ).join('');
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
    ['신고번호', '신고일자', '거래처', 'HS코드', '품목명', '수량', '단가', '통화', '합계금액'],
    ...STATE.rows.map(r => [
      r.declNumber,
      r.declDate,
      r.vendor,
      { t: 's', v: r.hsCode },   // 텍스트 강제 (과학적 표기 방지)
      r.itemName,
      r.quantity,
      r.unitPrice,
      r.currency || 'KRW',
      r.totalAmount,
    ]),
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
  ws1['!cols'] = [
    { wch: 20 }, { wch: 12 }, { wch: 25 }, { wch: 14 },
    { wch: 35 }, { wch: 10 }, { wch: 14 }, { wch: 8 }, { wch: 16 },
  ];
  applyNumberFormat(ws1, sheet1Data.length, [5, 6, 8], '#,##0');
  XLSX.utils.book_append_sheet(wb, ws1, '원본');

  // Sheet 2: 신고번호별
  const byDecl = groupAndSum(STATE.rows, 'declNumber', ['declDate', 'vendor', 'currency']);
  const sheet2Data = [
    ['신고번호', '신고일자', '거래처', '통화', '합계금액'],
    ...byDecl.map(g => [g.key, g.declDate, g.vendor, g.currency || 'KRW', g.sum]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(sheet2Data);
  ws2['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 25 }, { wch: 8 }, { wch: 16 }];
  applyNumberFormat(ws2, sheet2Data.length, [4], '#,##0');
  XLSX.utils.book_append_sheet(wb, ws2, '신고번호별');

  // Sheet 3: 월별 (통화별)
  const monthCurrMap = new Map();
  for (const r of STATE.rows) {
    const key = `${r.declMonth || '(없음)'}__${r.currency || 'KRW'}`;
    monthCurrMap.set(key, (monthCurrMap.get(key) || 0) + r.totalAmount);
  }
  const sheet3Data = [
    ['월', '통화', '합계금액'],
    ...[...monthCurrMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, total]) => {
        const [month, curr] = key.split('__');
        return [month, curr, total];
      }),
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(sheet3Data);
  ws3['!cols'] = [{ wch: 10 }, { wch: 8 }, { wch: 16 }];
  applyNumberFormat(ws3, sheet3Data.length, [2], '#,##0');
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
