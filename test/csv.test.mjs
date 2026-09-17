/**
 * CSV reader tests.
 *
 * The reader exists because a shifted column in a payment file turns a valid
 * IBAN into "invalid" and sends someone chasing a bug that is not there, so the
 * quoting and delimiter behaviour is pinned rather than assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, parseCsvToRecords, detectDelimiter } from '../lib/csv.js';

test('parses a simple comma file', () => {
  const { rows } = parseCsv('a,b\n1,2\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('quoted fields may contain the delimiter, newlines and doubled quotes', () => {
  const text = 'name,note\n"Ada, Inc.","said ""hello""\nsecond line"\n';
  const { rows } = parseCsv(text);
  assert.deepEqual(rows[1], ['Ada, Inc.', 'said "hello"\nsecond line']);
});

test('CRLF is handled the same as LF', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n').rows, [['a', 'b'], ['1', '2']]);
});

test('a UTF-8 BOM does not corrupt the first header', () => {
  const { rows } = parseCsv('\uFEFFiban,name\nGB82WEST12345698765432,Ada\n');
  assert.equal(rows[0][0], 'iban');
});

test('blank trailing lines are skipped, not returned as empty rows', () => {
  assert.equal(parseCsv('a,b\n1,2\n\n\n').rows.length, 2);
});

test('semicolon files are detected, which is what a European Excel export is', () => {
  assert.equal(detectDelimiter('Iban;Naam;Bedrag\nx;y;z\n'), ';');
  assert.equal(detectDelimiter('iban,name,amount\nx,y,z\n'), ',');
});

test('a comma inside a quoted header does not win the delimiter vote', () => {
  assert.equal(detectDelimiter('"name, full";amount\n"Ada, Inc.";10\n'), ';');
});

test('headers are normalised, so "Creditor IBAN" finds the iban column', () => {
  const { records } = parseCsvToRecords('Creditor IBAN,Creditor Name,Amount\nGB82WEST12345698765432,Ada,10\n');
  assert.equal(records[0].creditor_iban, 'GB82WEST12345698765432');
});

test('records carry the file line number, so a finding can point at the file', () => {
  const { records } = parseCsvToRecords('iban,name\nGB82WEST12345698765432,Ada\nDE89370400440532013000,Bob\n');
  assert.equal(records[0].__line, 2);
  assert.equal(records[1].__line, 3);
});

test('a short row does not shift later values into the wrong field', () => {
  const { records } = parseCsvToRecords('iban,name,amount,bic\nGB82WEST12345698765432,Ada,10.00\n');
  assert.equal(records[0].iban, 'GB82WEST12345698765432');
  assert.equal(records[0].name, 'Ada');
  assert.equal(records[0].amount, '10.00');
  assert.equal(records[0].bic, '');
});

test('an empty file yields no records rather than throwing', () => {
  assert.deepEqual(parseCsvToRecords('').records, []);
  assert.deepEqual(parseCsvToRecords('iban,name\n').records, []);
});