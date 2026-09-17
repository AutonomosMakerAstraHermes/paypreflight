/**
 * Audit engine tests.
 *
 * The fixtures are the specification here. Every count asserted below was
 * observed by running tools/check-fixtures.mjs first, so these tests pin
 * behaviour that exists rather than behaviour that was hoped for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsvToRecords } from '../lib/csv.js';
import { auditPaymentRun, formatReport, detectColumns } from '../lib/audit.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(root, 'fixtures', name), 'utf8');

const known = new Set(
  read('known-ibans.txt').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')),
);

const auditFixture = (name, options = {}) => {
  const { records } = parseCsvToRecords(read(name));
  return auditPaymentRun(records, { source: name, ...options });
};

const codesOf = (report) => report.findings.map((f) => f.code);
const finding = (report, code) => report.findings.find((f) => f.code === code);

test('a clean English CSV run passes with no blocking findings', () => {
  const report = auditFixture('suppliers-clean.csv');
  assert.equal(report.summary.rows, 4);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.blocking, false);
  assert.equal(report.summary.totalCents, 572574);
  assert.equal(report.summary.totalFormatted, '5725.74');
});

test('column mapping is detected from English headers', () => {
  const report = auditFixture('suppliers-clean.csv');
  assert.deepEqual(report.columns, {
    iban: 'creditor_iban', name: 'creditor_name', amount: 'amount', currency: 'currency',
    bic: 'bic', reference: 'remittance', date: 'execution_date', country: null, vat: null,
  });
});

test('Dutch headers and a semicolon delimiter are detected without configuration', () => {
  const { records, delimiter } = parseCsvToRecords(read('suppliers-messy.csv'));
  const report = auditPaymentRun(records, { source: 'messy' });
  assert.equal(delimiter, ';');
  assert.equal(report.columns.iban, 'iban');
  assert.equal(report.columns.name, 'naam');
  assert.equal(report.columns.amount, 'bedrag');
  assert.equal(report.columns.reference, 'mededeling');
  assert.equal(report.columns.date, 'uitvoeringsdatum');
});

test('the messy run is blocked and every defect class is grouped once', () => {
  const report = auditFixture('suppliers-messy.csv');
  assert.equal(report.summary.rows, 10);
  assert.equal(report.summary.blocking, true);
  assert.equal(report.summary.errors, 5);

  assert.equal(finding(report, 'iban_invalid').count, 2);
  assert.equal(finding(report, 'name_charset').count, 2);
  assert.equal(finding(report, 'amount_invalid').count, 1);
  assert.equal(finding(report, 'iban_missing').count, 1);
  assert.equal(finding(report, 'duplicate_reference').count, 2);

  // Grouped, not one entry per line.
  assert.equal(codesOf(report).filter((c) => c === 'iban_invalid').length, 1);
});

test('a wrong-checksum IBAN is reported with the exact replacement to use', () => {
  const report = auditFixture('suppliers-messy.csv');
  const bad = report.rows.find((r) => r.iban === 'GB82WEST12345698765433');
  const problem = bad.problems.find((p) => p.code === 'iban_invalid');
  assert.equal(problem.fix, 'GB55WEST12345698765433');
  assert.equal(bad.severity, 'error');
});

test('a valid IBAN outside SEPA is a warning, not an invalid IBAN', () => {
  const report = auditFixture('suppliers-messy.csv');
  const turkish = report.rows.find((r) => r.country === 'TR');
  assert.ok(turkish, 'the Turkish row should be present');
  assert.ok(turkish.problems.some((p) => p.code === 'iban_outside_sepa'), 'expected an outside-SEPA warning');
  assert.ok(!turkish.problems.some((p) => p.code === 'iban_invalid'), 'the IBAN itself is well formed');
});

test('European decimal notation is read as the amount it is', () => {
  const report = auditFixture('suppliers-messy.csv');
  const belgian = report.rows.find((r) => r.country === 'BE');
  assert.equal(belgian.amountCents, 123456, '"1.234,56" is 1234.56, not 1.23');
});

test('duplicate payees are found against a previously-paid reference list', () => {
  const report = auditFixture('suppliers-clean.csv', { knownIbans: known });
  assert.equal(report.summary.firstTimePayees, 1);
  assert.equal(finding(report, 'first_time_payee').count, 1);
  assert.equal(report.firstTimePayees[0].iban, 'NL91ABNA0417164300');
});

test('without a reference list no payee is called new', () => {
  const report = auditFixture('suppliers-clean.csv');
  assert.equal(report.summary.firstTimePayees, 0);
  assert.equal(finding(report, 'first_time_payee'), undefined);
});

test('an identical instruction on two lines is flagged as a possible double payment', () => {
  const records = [
    { __line: 1, iban: 'GB82WEST12345698765432', name: 'Ada Ltd', amount: '10.00', currency: 'EUR', bic: 'WESTGB22', date: '2026-01-01' },
    { __line: 2, iban: 'GB82WEST12345698765432', name: 'Ada Ltd', amount: '10.00', currency: 'EUR', bic: 'WESTGB22', date: '2026-01-01' },
  ];
  const report = auditPaymentRun(records);
  assert.equal(finding(report, 'duplicate_instruction').count, 1);
  assert.ok(finding(report, 'duplicate_instruction').message.includes('line 1'));
});

test('a row with a different date is not a duplicate', () => {
  const records = [
    { __line: 1, iban: 'GB82WEST12345698765432', name: 'Ada Ltd', amount: '10.00', currency: 'EUR', date: '2026-01-01' },
    { __line: 2, iban: 'GB82WEST12345698765432', name: 'Ada Ltd', amount: '10.00', currency: 'EUR', date: '2026-01-02' },
  ];
  assert.equal(auditPaymentRun(records).findings.find((f) => f.code === 'duplicate_instruction'), undefined);
});

test('declared header totals that disagree with the body block the file', () => {
  const records = [
    { __line: 1, iban: 'GB82WEST12345698765432', name: 'Ada Ltd', amount: '10.00', currency: 'EUR' },
    { __line: 2, iban: 'DE89370400440532013000', name: 'Beispiel GmbH', amount: '20.00', currency: 'EUR' },
  ];
  const report = auditPaymentRun(records, { declaredTotal: 2500, declaredCount: 2 });
  const total = finding(report, 'declared_total_mismatch');
  assert.equal(total.severity, 'error');
  assert.equal(total.exampleFix, 'Set the control sum to 30.00.');
  assert.equal(report.summary.totalCents, 3000);
  assert.equal(report.summary.blocking, true);
});

test('a capped run reports that it was truncated instead of silently stopping', () => {
  const records = Array.from({ length: 10 }, (_, i) => ({
    __line: i + 1, iban: 'GB82WEST12345698765432', name: `Payee ${i}`, amount: '1.00',
    currency: 'EUR', date: `2026-01-${String(i + 1).padStart(2, '0')}`,
  }));
  const report = auditPaymentRun(records, { maxRows: 3 });
  assert.equal(report.summary.rows, 3);
  assert.equal(report.summary.truncated, true);
  assert.equal(report.summary.totalCents, 300);
});

test('the report is deterministic for the same input', () => {
  const first = auditFixture('suppliers-messy.csv');
  const second = auditFixture('suppliers-messy.csv');
  assert.deepEqual(first.findings, second.findings);
  assert.deepEqual(first.summary, second.summary);
});

test('an empty run is clean rather than a crash', () => {
  const report = auditPaymentRun([]);
  assert.equal(report.summary.rows, 0);
  assert.equal(report.summary.clean, true);
  assert.equal(report.summary.blocking, false);
  assert.deepEqual(report.findings, []);
});

test('detectColumns leaves unknown fields unmapped rather than guessing', () => {
  const columns = detectColumns(['iban', 'name', 'amount', 'something_else']);
  assert.equal(columns.iban, 'iban');
  assert.equal(columns.date, null);
  assert.equal(columns.vat, null);
});

test('the text report names each fix', () => {
  const text = formatReport(auditFixture('suppliers-messy.csv'));
  assert.match(text, /FAIL/);
  assert.match(text, /iban_invalid/);
  assert.match(text, /fix: GB55WEST12345698765433/);
});