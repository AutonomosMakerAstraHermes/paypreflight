/**
 * A small RFC 4180 CSV reader.
 *
 * Written by hand rather than pulled in as a dependency for three reasons:
 * this package promises zero dependencies, the reader has to run unchanged in
 * Node and in a browser page, and payment files are the one place where a
 * half-wrong CSV parse is worse than no parse at all - a shifted column turns a
 * valid IBAN into "invalid" and sends someone chasing a bug that is not there.
 *
 * Handles: quoted fields, embedded commas, embedded newlines, doubled quotes as
 * an escaped quote, CRLF or LF, a trailing newline, and a UTF-8 BOM. Does not
 * handle: multi-byte quote look-alikes, or delimiter sniffing beyond , and ;.
 *
 * The delimiter is auto-detected from the header line when not supplied, which
 * is what European spreadsheet exports need - Excel in a comma-decimal locale
 * writes semicolon-separated files by default.
 */

/** Strip a leading UTF-8 BOM, which Excel writes and which would corrupt header 1. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Guess the delimiter by counting candidates outside quotes on the first line.
 * Semicolon wins ties because a comma inside a quoted name is common and a
 * semicolon inside one is not.
 */
export function detectDelimiter(text, candidates = [',', ';', '\t', '|']) {
  const firstLine = stripBom(text).split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const c = firstLine[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === candidate && !inQuotes) count++;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse CSV text into rows of strings.
 *
 * Returns { rows, delimiter } where `rows` includes the header as row 0. Blank
 * lines are skipped rather than returned as empty rows, because finance exports
 * routinely end with two or three of them.
 */
export function parseCsv(text, options = {}) {
  const source = stripBom(String(text ?? ''));
  const delimiter = options.delimiter ?? detectDelimiter(source);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    pushField();
    // A line of nothing but delimiters is still a row of empty fields; a truly
    // empty line is not a row. The row must be reset before returning, or the
    // skipped line's empty field joins the next one.
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];

    if (inQuotes) {
      if (c === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === delimiter) { pushField(); continue; }
    if (c === '\r') { if (source[i + 1] === '\n') i++; pushRow(); continue; }
    if (c === '\n') { pushRow(); continue; }
    field += c;
  }

  if (field !== '' || row.length > 0) pushRow();
  return { rows, delimiter };
}

/**
 * Parse CSV into objects keyed by header, with headers normalised the way
 * payment exports write them.
 *
 * Header matching is deliberately forgiving: "IBAN", "iban", "Iban " and
 * "Creditor IBAN" must all find the IBAN column, or the tool becomes useless on
 * real files. Headers are lowercased, stripped of accents and punctuation, and
 * collapsed to single underscores.
 */
export function parseCsvToRecords(text, options = {}) {
  const { rows, delimiter } = parseCsv(text, options);
  if (rows.length === 0) return { records: [], headers: [], delimiter };

  const headers = rows[0].map((h) => h.trim());
  const keys = headers.map((h) =>
    h.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const record = { __line: i + 1 };
    let empty = true;
    for (let c = 0; c < keys.length; c++) {
      const key = keys[c] || `column_${c + 1}`;
      const value = (cells[c] ?? '').trim();
      record[key] = value;
      if (value !== '') empty = false;
    }
    if (empty) continue;
    records.push(record);
  }
  return { records, headers, keys, delimiter };
}