/**
 * A development helper: run the audit over the fixture files and print the
 * findings, so fixture expectations in the test suite are written against
 * observed behaviour rather than assumed behaviour.
 *
 * Not part of the test suite and not shipped in the package tarball.
 *
 * Usage:  node tools/check-fixtures.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsvToRecords } from '../lib/csv.js';
import { auditPaymentRun, formatReport } from '../lib/audit.js';
import { auditPain001 } from '../lib/pain001.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(root, 'fixtures', name), 'utf8');

const known = new Set(
  read('known-ibans.txt')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#')),
);

for (const fixture of ['suppliers-clean.csv', 'suppliers-messy.csv']) {
  const text = read(fixture);
  const { records, delimiter } = parseCsvToRecords(text);
  const report = auditPaymentRun(records, { source: fixture, knownIbans: known });
  console.log(`${'='.repeat(72)}\n${fixture}  delimiter=${JSON.stringify(delimiter)}  records=${records.length}`);
  console.log(formatReport(report));
  console.log('findings:', report.findings.map((f) => `${f.severity}:${f.code}x${f.count}`).join(' '));
  console.log('detected columns:', JSON.stringify(report.columns));
  console.log('first-time payees:', report.firstTimePayees.length);
}

const pain = auditPain001(read('pain001-mismatch.xml'));
console.log(`${'='.repeat(72)}\npain001-mismatch.xml`);
console.log(formatReport(pain));
console.log('findings:', pain.findings.map((f) => `${f.severity}:${f.code}x${f.count}`).join(' '));
console.log('header:', JSON.stringify(pain.pain001.header));
console.log('summary:', JSON.stringify(pain.summary));