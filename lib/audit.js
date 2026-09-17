/**
 * The audit engine: one payment run in, one prioritised, fixable report out.
 *
 * Design rules
 * ------------
 * 1. One engine, every input format. CSV, JSON and pain.001 all become records,
 *    and every record goes through exactly this code. There is no second
 *    implementation for XML, so a CSV row and an XML instruction can never be
 *    held to different standards.
 * 2. Grouped findings, not a log. The output answers "what do I fix?" - one
 *    entry per defect class with a count and the offending lines - rather than
 *    one line per failure. A 4,000-row file with one bad export setting should
 *    produce one finding, not 4,000.
 * 3. Severity is about consequence, not tidiness.
 *      error   - would be rejected or returned by a bank, or would send money
 *                to the wrong place. Blocks a file being sent.
 *      warning - a person must look before this goes out.
 *      info    - worth knowing, safe to send as is.
 * 4. Every error carries a fix when a fix is computable. If the check digits
 *    are wrong, the report says what they should be.
 * 5. Deterministic. Same input, same report, so a report can be diffed in CI.
 */

import { validateIban, groupInFours } from './iban.js';
import {
  isSepaCountry, checkSepaCharset, checkRemittance, checkAmount,
  checkCurrency, checkBic, ibanCountry, sepaPrefixHint,
} from './sepa.js';

/** The country prefix of an IBAN, re-exported so callers need one import. */
const countryOfIban = ibanCountry;

/** Severity ordering, most severe first. */
export const SEVERITY_ORDER = ['error', 'warning', 'info'];

/**
 * Column aliases, in the languages these files actually arrive in.
 *
 * English, Dutch, German, French and Spanish cover the overwhelming majority of
 * European payment exports. First match wins, so more specific aliases lead.
 */
const COLUMN_ALIASES = {
  iban: ['creditor_iban', 'beneficiary_iban', 'iban', 'account_number', 'account', 'rekeningnummer', 'iban_nummer', 'kontonummer', 'cuenta'],
  name: ['creditor_name', 'beneficiary_name', 'name', 'creditor', 'beneficiary', 'naam', 'beguenstigter', 'empfaenger', 'nom', 'nombre', 'libelle'],
  amount: ['amount', 'instd_amt', 'bedrag', 'betrag', 'importe', 'montant', 'value', 'sum', 'amount_eur'],
  currency: ['currency', 'ccy', 'valuta', 'waehrung', 'devise', 'moneda'],
  bic: ['bic', 'swift', 'swift_bic', 'bic_code'],
  reference: ['remittance', 'remittance_information', 'reference', 'endtoendid', 'end_to_end_id', 'mededeling', 'verwendungszweck', 'motif', 'concepto', 'payment_reference'],
  date: ['execution_date', 'requested_execution_date', 'due_date', 'date', 'uitvoeringsdatum', 'faelligkeit', 'fecha'],
  country: ['country', 'land', 'pays', 'pais'],
  vat: ['vat', 'vat_number', 'vat_id', 'btw', 'ust_id', 'ustid', 'tva', 'nif'],
};

/** Find the first column key that matches an alias list. Null when absent. */
export function detectColumns(keys) {
  const mapping = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    mapping[field] = keys.find((key) => aliases.includes(key)) ?? null;
  }
  return mapping;
}

/** Turn a raw record into the canonical shape the checks operate on. */
export function readRow(record, columns, fallbackCurrency = 'EUR') {
  const get = (field) => {
    const key = columns[field];
    if (!key) return '';
    const value = record[key];
    return value === undefined || value === null ? '' : String(value).trim();
  };
  return {
    iban: get('iban'),
    name: get('name'),
    amount: get('amount'),
    currency: get('currency') || fallbackCurrency,
    bic: get('bic'),
    reference: get('reference'),
    date: get('date'),
    country: get('country'),
    vat: get('vat'),
  };
}

/**
 * Audit one row. Returns { severity, problems, suggestions, cents }.
 *
 * `options.knownIbans`, when supplied, is a Set of account numbers that have
 * been paid before. Anything not in it is a first-time payee, which is the
 * single most useful control a payment run can get for free: paying a new
 * account is where both fraud and typos land.
 */
export function auditRow(row, options = {}) {
  const problems = [];
  const suggestions = [];
  const add = (code, severity, message, fix = null) => {
    problems.push(fix ? { code, severity, message, fix } : { code, severity, message });
  };

  let country = null;

  // ---- account identity -------------------------------------------------
  if (row.iban === '') {
    add('iban_missing', 'error', 'No creditor IBAN on this line.');
  } else {
    const checked = validateIban(row.iban);
    if (!checked.valid) {
      // A prefix that looks like SEPA but has no IBAN structure of its own is
      // the one case where "invalid" needs an explanation rather than a fix.
      const hint = checked.country === null ? null : sepaPrefixHint(checked.country);
      add(
        'iban_invalid',
        'error',
        `Creditor IBAN ${row.iban} failed ISO 13616 validation: ${checked.errors[0]}${hint ? ` ${hint}` : ''}`,
        checked.suggestedIban ?? null,
      );
      if (checked.suggestedIban) {
        suggestions.push(`Replace ${row.iban} with ${checked.suggestedIban} (${groupInFours(checked.suggestedIban)}) - the account digits are unchanged and only the check digits differ.`);
      }
    } else {
      country = countryOfIban(checked.iban);
      if (!isSepaCountry(country)) {
        add('iban_outside_sepa', 'warning', `Creditor IBAN ${checked.iban} is a valid ${checked.countryName} IBAN, but ${country} is outside the SEPA geographical scope. A euro credit transfer cannot reach this account; this instruction needs a different scheme.`);
      }
      if (row.country && row.country.toUpperCase() !== country) {
        add('country_mismatch', 'warning', `The country column says ${row.country.toUpperCase()} but the IBAN is a ${country} account.`);
      }
      if (options.knownIbans instanceof Set && !options.knownIbans.has(checked.iban)) {
        add('first_time_payee', 'warning', `${checked.iban} has not been paid before in the reference file supplied, so this is a first-time payee.`);
      }
    }
  }

  // ---- payee name -------------------------------------------------------
  if (row.name === '') {
    add('name_missing', 'error', 'No creditor name. Banks reject instructions without a beneficiary name.');
  } else {
    const charset = checkSepaCharset(row.name, 'Creditor name');
    if (!charset.ok) {
      add('name_charset', 'error', charset.problems[0]);
      if (charset.offences.length > 0) {
        let cleaned = row.name;
        for (const offence of charset.offences) cleaned = cleaned.split(offence.char).join('');
        cleaned = cleaned.replace(/ {2,}/g, ' ').trim();
        if (/[A-Za-z0-9]/.test(cleaned)) suggestions.push(`Strip the disallowed character(s) from the creditor name: ${JSON.stringify(cleaned)}.`);
      }
    }
  }

  // ---- money ------------------------------------------------------------
  const amount = checkAmount(row.amount);
  if (!amount.ok) add('amount_invalid', 'error', amount.problems[0]);

  const currency = checkCurrency(row.currency, options.currency ?? 'EUR');
  if (!currency.ok) add('currency_invalid', 'error', currency.problems[0]);

  // ---- bank identifier --------------------------------------------------
  const bic = checkBic(row.bic, row.iban);
  if (!bic.ok) add('bic_invalid', 'error', bic.problems[0]);
  else if (row.bic === '' && country !== null && !isSepaCountry(country)) {
    add('bic_required', 'error', `No BIC on a ${country} account, which is outside the SEPA scope - a BIC is required for that instruction.`);
  }

  // ---- reference --------------------------------------------------------
  if (row.reference !== '') {
    const remittance = checkRemittance(row.reference, options.maxRemittanceLength ?? 140);
    if (!remittance.ok) add('reference_invalid', 'warning', remittance.problems[0]);
  }

  const severity = problems.some((p) => p.severity === 'error')
    ? 'error'
    : problems.some((p) => p.severity === 'warning') ? 'warning' : 'ok';

  return { severity, problems, suggestions, cents: amount.ok ? amount.cents : null };
}

/**
 * Audit a whole payment run.
 *
 * @param {object[]} records  Canonical rows, or raw records plus `columns`.
 * @param {object}  options
 *   - columns         explicit column mapping; omit to auto-detect from keys
 *   - knownIbans      Set of previously paid IBANs, enables first_time_payee
 *   - currency        expected currency, default EUR
 *   - declaredTotal   total declared by the file's own header (pain.001 CtrlSum)
 *   - declaredCount   instruction count declared by the file header (NbOfTxs)
 *   - source          label for the input, echoed into the report
 *   - maxRows         refuse to audit more than this many rows (free-tier cap)
 *
 * @returns {object} report
 */
export function auditPaymentRun(records, options = {}) {
  const maxRows = options.maxRows ?? Infinity;
  const columns = options.columns
    ?? detectColumns(records.length > 0 ? Object.keys(records[0]).filter((k) => k !== '__line') : []);

  const rows = [];
  const findingsByCode = new Map();
  const duplicates = new Map();
  const referenceSeen = new Map();
  const firstTimePayees = [];
  const suggestions = [];
  let totalCents = 0;
  let errorCount = 0;
  let warningCount = 0;
  const byCountry = new Map();

  const limit = Math.min(records.length, maxRows);
  const truncated = records.length > limit;

  for (let i = 0; i < limit; i++) {
    const record = records[i];
    const line = record.__line ?? i + 1;
    const row = readRow(record, columns, options.currency ?? 'EUR');
    const audited = auditRow(row, options);

    if (audited.cents !== null) totalCents += audited.cents;
    if (audited.severity === 'error') errorCount++;
    else if (audited.severity === 'warning') warningCount++;

    const country = row.iban ? ibanCountry(row.iban) : null;
    if (country) byCountry.set(country, (byCountry.get(country) ?? 0) + 1);

    // Cross-row checks, recorded against the later of the two lines.
    if (audited.cents !== null && row.iban !== '') {
      const key = `${row.iban.replace(/\s+/g, '').toUpperCase()}|${audited.cents}|${row.date}`;
      const previous = duplicates.get(key);
      if (previous !== undefined) {
        audited.problems.push({
          code: 'duplicate_instruction',
          severity: 'warning',
          message: `Identical instruction to line ${previous}: same IBAN, same amount and same date. Either a legitimate split payment or a double payment.`,
        });
        if (audited.severity === 'ok') { audited.severity = 'warning'; warningCount++; }
        suggestions.push(`Compare lines ${previous} and ${line}: they pay the same account the same amount on the same date.`);
      } else {
        duplicates.set(key, line);
      }
    }

    if (row.reference !== '') {
      const key = row.reference.toUpperCase();
      const previous = referenceSeen.get(key);
      if (previous !== undefined) {
        audited.problems.push({
          code: 'duplicate_reference',
          severity: 'warning',
          message: `Remittance reference ${JSON.stringify(row.reference)} was already used on line ${previous}. End-to-end references are expected to be unique and a bank may reject a file that repeats one.`,
        });
        if (audited.severity === 'ok') { audited.severity = 'warning'; warningCount++; }
        suggestions.push(`Make the reference on line ${line} unique, e.g. append a sequence number.`);
      } else {
        referenceSeen.set(key, line);
      }
    }

    for (const problem of audited.problems) {
      let finding = findingsByCode.get(problem.code);
      if (!finding) {
        finding = {
          code: problem.code,
          severity: problem.severity,
          count: 0,
          message: problem.message,
          lines: [],
          exampleFix: problem.fix ?? null,
        };
        findingsByCode.set(problem.code, finding);
      }
      finding.count++;
      if (finding.lines.length < 25) finding.lines.push(line);
      if (finding.exampleFix === null && problem.fix) finding.exampleFix = problem.fix;
    }

    if (audited.problems.some((p) => p.code === 'first_time_payee')) {
      firstTimePayees.push({ line, iban: row.iban, name: row.name });
    }

    rows.push({
      line,
      severity: audited.severity,
      iban: row.iban,
      name: row.name,
      amountCents: audited.cents,
      currency: row.currency,
      country,
      problems: audited.problems,
      suggestions: audited.suggestions,
    });
  }
addHeaderTotals(findingsByCode, suggestions, options, totalCents, limit);

  const findings = Array.from(findingsByCode.values()).sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.count - a.count,
  );
  errorCount += findings.filter((f) => f.severity === 'error' && f.code.startsWith('declared_')).length;

  return {
    schema: 'paypreflight/audit/1',
    tool: { name: 'paypreflight', version: options.toolVersion ?? '0.1.0' },
    source: options.source ?? null,
    columns,
    summary: {
      rows: limit,
      truncated,
      errors: errorCount,
      warnings: warningCount,
      clean: errorCount === 0 && warningCount === 0,
      blocking: errorCount > 0,
      totalCents,
      totalFormatted: (totalCents / 100).toFixed(2),
      firstTimePayees: firstTimePayees.length,
      countries: Array.from(byCountry.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => ({ code, count })),
    },
    findings,
    firstTimePayees,
    suggestions: Array.from(new Set(suggestions)).slice(0, 50),
    rows,
  };
}

/**
 * Declared-versus-actual totals.
 *
 * This is the classic pain.001 defect: a file's header totals stop matching its
 * body after someone edits it by hand, and the bank rejects the whole file on
 * upload. Cheap to check, expensive to miss.
 */
function addHeaderTotals(findingsByCode, suggestions, options, totalCents, limit) {
  if (typeof options.declaredTotal === 'number' && options.declaredTotal !== totalCents) {
    const difference = ((totalCents - options.declaredTotal) / 100).toFixed(2);
    findingsByCode.set('declared_total_mismatch', {
      code: 'declared_total_mismatch',
      severity: 'error',
      count: 1,
      message: `The file header declares a control sum of ${(options.declaredTotal / 100).toFixed(2)} but the instructions add up to ${(totalCents / 100).toFixed(2)}, a difference of ${difference}. Banks reject a file whose control sum does not match.`,
      lines: [],
      exampleFix: `Set the control sum to ${(totalCents / 100).toFixed(2)}.`,
    });
    suggestions.push(`Set the control sum to ${(totalCents / 100).toFixed(2)}.`);
  }

  if (typeof options.declaredCount === 'number' && options.declaredCount !== limit) {
    findingsByCode.set('declared_count_mismatch', {
      code: 'declared_count_mismatch',
      severity: 'error',
      count: 1,
      message: `The file header declares ${options.declaredCount} instruction(s) but the body contains ${limit}.`,
      lines: [],
      exampleFix: `Set the transaction count to ${limit}.`,
    });
    suggestions.push(`Set the transaction count to ${limit}.`);
  }
}

/** Render a report as text for a terminal. Summary first, then what to fix. */
export function formatReport(report) {
  const lines = [];
  const s = report.summary;
  lines.push(`paypreflight - ${report.source ?? 'input'} - ${s.rows} instruction(s) - ${s.totalFormatted} EUR`);

  if (s.clean) {
    lines.push('PASS  No blocking defects and nothing needing review.');
  } else {
    lines.push(`${s.blocking ? 'FAIL' : 'REVIEW'}  ${s.errors} error(s), ${s.warnings} warning(s)`);
  }

  for (const finding of report.findings) {
    const mark = finding.severity === 'error' ? 'ERROR  ' : finding.severity === 'warning' ? 'WARN   ' : 'NOTE   ';
    const extra = finding.count > finding.lines.length ? ` (+${finding.count - finding.lines.length} more)` : '';
    const where = finding.lines.length > 0 ? ` on line(s) ${finding.lines.join(', ')}${extra}` : '';
    lines.push('');
    lines.push(`${mark}${finding.count}x ${finding.code}${where}`);
    lines.push(`       ${finding.message}`);
    if (finding.exampleFix) lines.push(`       fix: ${finding.exampleFix}`);
  }

  if (report.suggestions.length > 0) {
    lines.push('');
    lines.push('Changes that would clear the findings:');
    for (const suggestion of report.suggestions) lines.push(`  - ${suggestion}`);
  }
  if (s.countries.length > 0) {
    lines.push('');
    lines.push(`Countries: ${s.countries.map((c) => `${c.code} (${c.count})`).join(', ')}`);
  }
  return lines.join('\n');
}