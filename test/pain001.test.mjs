/**
 * pain.001 reader tests.
 *
 * Note what these do NOT claim: there is no XSD schema validation here. The
 * reader's job is consistency - control sums, counts, identifiers, and the
 * instruction data that later goes through the shared audit engine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePain001, auditPain001, toCents, decodeXml } from '../lib/pain001.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = readFileSync(join(root, 'fixtures', 'pain001-mismatch.xml'), 'utf8');

const minimal = (header, batch, transactions) => `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>
${header}${batch}${transactions}</CstmrCdtTrfInitn></Document>`;

const GOOD_HEADER = '<GrpHdr><MsgId>M-1</MsgId><CreDtTm>2026-09-17T08:00:00</CreDtTm><NbOfTxs>1</NbOfTxs><CtrlSum>10.00</CtrlSum></GrpHdr>';
const GOOD_BATCH = '<PmtInf><PmtInfId>P-1</PmtInfId><NbOfTxs>1</NbOfTxs><CtrlSum>10.00</CtrlSum><ReqdExctnDt>2026-09-18</ReqdExctnDt><Dbtr><Nm>Acme</Nm></Dbtr>';
const CLOSE_BATCH = '</PmtInf>';
const GOOD_TX = '<CdtTrfTxInf><PmtId><EndToEndId>E-1</EndToEndId></PmtId><Amt><InstdAmt Ccy="EUR">10.00</InstdAmt></Amt><Cdtr><Nm>Ada Ltd</Nm></Cdtr><CdtrAcct><Id><IBAN>GB82WEST12345698765432</IBAN></Id></CdtrAcct></CdtTrfTxInf>';

test('a well-formed document is read cleanly', () => {
  const report = auditPain001(minimal(GOOD_HEADER, GOOD_BATCH, GOOD_TX + CLOSE_BATCH));
  assert.equal(report.summary.errors, 0, JSON.stringify(report.findings));
  assert.equal(report.summary.rows, 1);
  assert.equal(report.summary.totalCents, 1000);
});

test('the header is read into a usable shape', () => {
  const { header, records } = parsePain001(fixture);
  assert.equal(header.msgId, 'PAYPREFLIGHT-DEMO-0001');
  assert.equal(header.nbOfTxs, 3);
  assert.equal(header.ctrlSumCents, 50000);
  assert.equal(header.batches, 1);
  assert.equal(records.length, 3);
  assert.equal(records[0].iban, 'GB82WEST12345698765432');
  assert.equal(records[0].reference, 'E2E-0001');
  assert.equal(records[0].date, '2026-09-18');
  assert.equal(records[0].currency, 'EUR');
});

test('XML entities in names are decoded before the charset check sees them', () => {
  assert.equal(decodeXml('Handel &amp; Zonen'), 'Handel & Zonen');
  const report = auditPain001(minimal(GOOD_HEADER, GOOD_BATCH, GOOD_TX + CLOSE_BATCH));
  assert.equal(report.rows[0].name, 'Ada Ltd');
});

test('a control sum that does not match the body fails the document', () => {
  const report = auditPain001(fixture);
  const total = report.findings.find((f) => f.code === 'declared_total_mismatch');
  assert.ok(total, 'expected a control sum finding');
  assert.equal(total.severity, 'error');
  assert.equal(report.summary.totalCents, 552575);
  assert.equal(report.summary.blocking, true);
});

test('a batch control sum that disagrees is reported separately from the header', () => {
  const report = auditPain001(fixture);
  assert.ok(report.findings.some((f) => f.code === 'pain001_batch_sum_mismatch'));
});

test('instruction defects are found by the same engine as a CSV row', () => {
  const report = auditPain001(fixture);
  assert.ok(report.findings.some((f) => f.code === 'iban_invalid'), 'a bad IBAN must be caught');
  assert.ok(report.findings.some((f) => f.code === 'name_charset'), 'an ampersand must be caught');
});

test('missing elements are reported as missing, not treated as fine', () => {
  const noIban = GOOD_TX.replace('<CdtrAcct><Id><IBAN>GB82WEST12345698765432</IBAN></Id></CdtrAcct>', '');
  assert.ok(auditPain001(minimal(GOOD_HEADER, GOOD_BATCH, noIban + CLOSE_BATCH)).findings.some((f) => f.code === 'pain001_no_iban'));

  const noAmount = GOOD_TX.replace('<Amt><InstdAmt Ccy="EUR">10.00</InstdAmt></Amt>', '');
  assert.ok(auditPain001(minimal(GOOD_HEADER, GOOD_BATCH, noAmount + CLOSE_BATCH)).findings.some((f) => f.code === 'pain001_no_amount'));

  const noCurrency = GOOD_TX.replace('Ccy="EUR"', '');
  assert.ok(auditPain001(minimal(GOOD_HEADER, GOOD_BATCH, noCurrency + CLOSE_BATCH)).findings.some((f) => f.code === 'pain001_no_currency'));
});

test('a document that is not a pain.001 is named as such', () => {
  const report = auditPain001('<html><body>not a payment file</body></html>');
  assert.ok(report.findings.some((f) => f.code === 'pain001_no_header'));
  assert.equal(report.summary.blocking, true);
});

test('a transaction count that disagrees with the body is caught', () => {
  const header = GOOD_HEADER.replace('<NbOfTxs>1</NbOfTxs>', '<NbOfTxs>5</NbOfTxs>');
  const report = auditPain001(minimal(header, GOOD_BATCH, GOOD_TX + CLOSE_BATCH));
  assert.ok(report.findings.some((f) => f.code === 'declared_count_mismatch'));
});

test('identifiers longer than 35 characters are rejected', () => {
  const header = GOOD_HEADER.replace('M-1', 'X'.repeat(36));
  const report = auditPain001(minimal(header, GOOD_BATCH, GOOD_TX + CLOSE_BATCH));
  assert.ok(report.findings.some((f) => f.code === 'pain001_id_too_long'));
});

test('namespace prefixes are tolerated', () => {
  const xml = minimal(GOOD_HEADER, GOOD_BATCH, GOOD_TX + CLOSE_BATCH).replace(/<(\/?)(\w)/g, '<$1ns:$2');
  const report = auditPain001(xml);
  assert.equal(report.summary.rows, 1, JSON.stringify(report.findings));
});

test('CDATA-wrapped values are unwrapped', () => {
  const tx = GOOD_TX.replace('<Nm>Ada Ltd</Nm>', '<Nm><![CDATA[Ada Ltd]]></Nm>');
  const report = auditPain001(minimal(GOOD_HEADER, GOOD_BATCH, tx + CLOSE_BATCH));
  assert.equal(report.rows[0].name, 'Ada Ltd');
});

test('amounts convert to cents exactly, without float drift', () => {
  assert.equal(toCents('10.00'), 1000);
  assert.equal(toCents('999999999.99'), 99999999999);
  assert.equal(toCents('0.01'), 1);
  assert.equal(toCents('1234.5'), 123450);
  assert.equal(toCents('abc'), null);
  assert.equal(toCents(null), null);
});