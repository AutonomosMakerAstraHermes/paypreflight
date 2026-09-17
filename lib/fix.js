/**
 * Fix engine: apply the corrections the report describes.
 *
 * The difference between this and a validator is the difference between a
 * diagnosis and a repair. A report saying "IBAN on line 4 has the wrong check
 * digits" leaves the work on the person with 400 more lines to send. This
 * module rewrites the run so the defect is gone, and records what it changed,
 * because an automated edit to a payment file has to be reviewable.
 *
 * Two rules the code enforces on itself:
 *
 *  1. A fix is applied only when the result is verifiably correct. A repaired
 *     IBAN is re-validated by repairIban() before it is written, and a rewritten
 *     name must still contain a letter or digit.
 *  2. Anything needing a human decision is left alone and reported. A missing
 *     IBAN, a zero amount, an unparseable number - inventing a value would be
 *     worse than failing. Those come back in `unfixable`.
 */

import { validateIban, repairIban } from './iban.js';
import { checkSepaCharset, parseAmount } from './sepa.js';

/**
 * Compute the fixes for one record. Returns { changes, unfixable }.
 *
 * `changes` is a list of { field, from, to, reason } and is the audit trail
 * that accompanies the written file.
 */
export function fixRow(row) {
  const changes = [];
  const unfixable = [];

  // ---- IBAN -------------------------------------------------------------
  if (row.iban === '') {
    unfixable.push({ code: 'iban_missing', message: 'No IBAN to repair on this line.' });
  } else {
    const checked = validateIban(row.iban);
    if (!checked.valid) {
      const repaired = repairIban(row.iban);
      if (repaired) {
        changes.push({
          field: 'iban',
          from: row.iban,
          to: repaired.iban,
          reason: `Check digits corrected: ${checked.checkDigits} does not match the account digits, ${repaired.checkDigits} does. The account digits are unchanged.`,
        });
      } else {
        unfixable.push({ code: 'iban_invalid', message: `${row.iban}: ${checked.errors[0]}` });
      }
    }
  }

  // ---- creditor name ----------------------------------------------------
  if (row.name === '') {
    unfixable.push({ code: 'name_missing', message: 'No creditor name to repair.' });
  } else {
    const charset = checkSepaCharset(row.name, 'Creditor name');
    if (!charset.ok && charset.offences.length > 0) {
      let cleaned = row.name;
      for (const offence of charset.offences) cleaned = cleaned.split(offence.char).join('');
      cleaned = cleaned.replace(/ {2,}/g, ' ').trim();
      if (/[A-Za-z0-9]/.test(cleaned)) {
        changes.push({
          field: 'name',
          from: row.name,
          to: cleaned,
          reason: `Removed ${charset.offences.map((o) => JSON.stringify(o.char)).join(', ')}, which the EPC character set does not carry.`,
        });
      } else {
        unfixable.push({
          code: 'name_charset',
          message: `Stripping the disallowed characters from ${JSON.stringify(row.name)} would leave nothing usable.`,
        });
      }
    } else {
      const cleaned = row.name.replace(/ {2,}/g, ' ').trim();
      if (cleaned !== row.name) {
        changes.push({ field: 'name', from: row.name, to: cleaned, reason: 'Whitespace normalised.' });
      }
    }
  }

  // ---- amount -----------------------------------------------------------
  if (row.amount === '') {
    unfixable.push({ code: 'amount_missing', message: 'No amount to repair.' });
  } else {
    const parsed = parseAmount(row.amount);
    if (parsed.ok) {
      const normalised = (parsed.cents / 100).toFixed(2);
      const original = String(row.amount).trim();
      // Rewrite only when the meaning or the canonical form differs, so a file
      // that already says "10.00" is left byte-identical.
      if (original !== normalised) {
        changes.push({
          field: 'amount',
          from: original,
          to: normalised,
          reason: `Amount rewritten to canonical form from ${original}. The value is unchanged at ${normalised}.`,
        });
      }
    } else {
      unfixable.push({ code: 'amount_invalid', message: `${row.amount} is not a number that can be repaired.` });
    }
  }

  // ---- currency and BIC -------------------------------------------------
  const currency = String(row.currency ?? '').trim().toUpperCase();
  if (currency !== '' && currency !== row.currency) {
    changes.push({ field: 'currency', from: row.currency, to: currency, reason: 'Currency code uppercased.' });
  }

  const bic = String(row.bic ?? '').replace(/\s+/g, '').toUpperCase();
  if (bic !== '' && bic !== row.bic) {
    changes.push({ field: 'bic', from: row.bic, to: bic, reason: 'BIC normalised to uppercase without spaces.' });
  }

  return { changes, unfixable };
}

/**
 * Fix a whole run.
 *
 * Returns { records, changes, unfixable, summary } where `records` are the
 * corrected records in the same order and with the same keys as the input,
 * ready to be written back out.
 */
export function fixRun(records, columns) {
  const out = [];
  const changes = [];
  const unfixable = [];

  records.forEach((record, index) => {
    const line = record.__line ?? index + 1;

    // Build the canonical row either from the detected column mapping or, when
    // no mapping was found, from the record's own keys.
    const row = columns === undefined
      ? { ...record }
      : Object.fromEntries(
        Object.entries(columns).map(([field, key]) => [field, key ? String(record[key] ?? '') : '']),
      );

    const { changes: rowChanges, unfixable: rowUnfixable } = fixRow(row);

    const fixed = { ...record };
    for (const change of rowChanges) {
      const key = columns ? columns[change.field] : change.field;
      if (key) fixed[key] = change.to;
      changes.push({ line, ...change });
    }
    for (const problem of rowUnfixable) unfixable.push({ line, ...problem });

    out.push(fixed);
  });

  return {
    records: out,
    changes,
    unfixable,
    summary: {
      rows: records.length,
      changed: new Set(changes.map((c) => c.line)).size,
      changes: changes.length,
      unfixable: unfixable.length,
    },
  };
}

/** Serialise records back to CSV, quoting only where RFC 4180 requires it. */
export function toCsv(records, headers, delimiter = ',') {
  const cell = (value) => {
    const text = value === undefined || value === null ? '' : String(value);
    const needsQuoting = text.includes('"') || text.includes('\n') || text.includes('\r') || text.includes(delimiter);
    return needsQuoting ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [headers.map(cell).join(delimiter)];
  for (const record of records) lines.push(headers.map((header) => cell(record[header])).join(delimiter));
  return `${lines.join('\n')}\n`;
}

/** Describe the changes per line so a reviewer can see what happened to each. */
export function describeChanges(result) {
  const lines = [];
  if (result.changes.length === 0) {
    lines.push('Nothing needed to be changed.');
  } else {
    lines.push(`${result.summary.changes} change(s) across ${result.summary.changed} line(s):`);
    for (const change of result.changes) {
      lines.push(`  line ${change.line} ${change.field}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`);
      lines.push(`           ${change.reason}`);
    }
  }
  if (result.unfixable.length > 0) {
    lines.push('');
    lines.push(`${result.unfixable.length} defect(s) left for a person, because a mechanical fix would be a guess:`);
    for (const item of result.unfixable) lines.push(`  line ${item.line} ${item.code}: ${item.message}`);
  }
  return lines.join('\n');
}