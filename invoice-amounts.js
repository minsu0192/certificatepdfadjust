// Shared amount parsing. Bare integers are accepted only inside a labelled amount field.
(() => {
  const currency = '(?:KRW|USD|EUR|JPY|GBP|CNY|CHF|HKD|SGD|AUD|CAD|₩|\\$|€|원)';
  function parse(value) {
    if (value == null) return null;
    const raw = String(value).trim();
    const number = raw.replace(new RegExp(currency, 'gi'), '').replace(/[\s,()]/g, '');
    if (!/^-?\d+(?:\.\d+)?$/.test(number)) return null;
    const amount = Number(number);
    return Number.isFinite(amount) ? (/^\(.*\)$/.test(raw) ? -Math.abs(amount) : amount) : null;
  }
  function matches(text) {
    return [...String(text || '').matchAll(/(?<![\w.,/\-])-?\(?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?(?![\d.,])|(?<![\w.,/\-])-?\(?\d+\.\d{2}\)?(?![\d.,])/g)]
      .map(m => parse(m[0])).filter(n => n != null);
  }
  function field(text) {
    let clean = String(text || '').trim().replace(/^[:：=]\s*/, '')
      .replace(/\(?\d+(?:\.\d+)?\s*%\)?/g, '')
      .replace(new RegExp(`\\(\\s*(${currency})\\s*\\)`, 'gi'), '$1')
      .replace(/[＊*†‡]+$/g, '').trim();
    // OCR often replaces thousands separators with spaces. Do not silently pick its last group.
    clean = clean.replace(/(?<![\d.,])\d{1,3}(?:[ \u00a0]\d{3})+(?![\d.,])/g, n => n.replace(/[ \u00a0]/g, ','));
    const token = `${currency}?\\s*-?\\(?\\d+(?:,\\d{3})*(?:\\.\\d+)?\\)?\\s*${currency}?`;
    if (!new RegExp(`^${token}$`, 'i').test(clean)) return [];
    const amount = parse(clean); return amount == null ? [] : [amount];
  }
  function forLabel(lines, index, label) {
    const match = lines[index].match(label); if (!match) return null;
    const same = field(lines[index].slice(match.index + match[0].length));
    if (same.length) return same[same.length - 1];
    // Only a standalone amount may continue on the next line; never another labelled total.
    const suffix = lines[index].slice(match.index + match[0].length)
      .replace(/\(?\d+(?:\.\d+)?\s*%\)?/g, '')
      .replace(new RegExp(currency, 'gi'), '').replace(/[:：\s()]/g, '');
    if (suffix) return null;
    const next = field(lines[index + 1]); return next.length ? next[0] : null;
  }
  function near(text, label) {
    const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) { const value = forLabel(lines, i, label); if (value != null) return value; }
    return null;
  }
  function sum(text, label) {
    const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
    const values = lines.map((_, i) => forLabel(lines, i, label)).filter(n => n != null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  }
  const isZeroRated = text => /영세|Zero\s*Rated|(?<![\d.])0\s*%/i.test(text);
  window.InvoiceAmounts = { parse, matches, near, sum, isZeroRated };
})();
