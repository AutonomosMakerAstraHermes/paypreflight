/**
 * IBAN tests.
 *
 * The reference IBANs are the ones published by national banking authorities
 * and already used by stream 01's suite, so a regression here is a regression
 * against the implementation that serves live traffic.
 *
 * Run: node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateIban, checkDigitsFor, repairIban, mod97, groupInFours,
  supportedIbanCountries, ibanLengthFor, IBAN_COUNTRY_COUNT,
} from '../lib/iban.js';

const VALID = {
  GB: 'GB82WEST12345698765432',
  DE: 'DE89370400440532013000',
  FR: 'FR1420041010050500013M02606',
  NL: 'NL91ABNA0417164300',
  NO: 'NO9386011117947',
  'IT': 'IT60X0542811101000000123456',
  ES: 'ES9121000418450200051332',
};

test('registry is the size the live service reports', () => {
  assert.equal(IBAN_COUNTRY_COUNT, 116);
  assert.equal(supportedIbanCountries().length, 116);
});

test('accepts every published reference IBAN', () => {
  for (const [country, iban] of Object.entries(VALID)) {
    const result = validateIban(iban);
    assert.equal(result.valid, true, `${iban} should be valid: ${result.errors.join(' ')}`);
    assert.equal(result.country, country);
    assert.deepEqual(result.errors, []);
  }
});

test('accepts an IBAN written with spaces and lowercase', () => {
  const result = validateIban('gb82 west 1234 5698 7654 32');
  assert.equal(result.valid, true);
  assert.equal(result.iban, VALID.GB);
  assert.equal(result.formatted, 'GB82 WEST 1234 5698 7654 32');
});

test('rejects a transposed check digit pair and proposes the correct one', () => {
  // 82 -> 28 is the classic OCR/keying transposition.
  const result = validateIban('GB28WEST12345698765432');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /Checksum failed/);
  assert.equal(result.suggestedIban, VALID.GB, 'the repair must be the published IBAN');
  assert.equal(validateIban(result.suggestedIban).valid, true, 'every suggestion must itself validate');
});

test('check digits computed from the BBAN match the published IBAN', () => {
  assert.equal(checkDigitsFor('GB', 'WEST12345698765432'), '82');
  assert.equal(checkDigitsFor('DE', '370400440532013000'), '89');
  assert.equal(checkDigitsFor('NL', 'ABNA0417164300'), '91');
});

test('repair refuses to invent an IBAN it cannot verify', () => {
  assert.equal(repairIban('GB82WEST1234'), null, 'wrong length must not be repaired');
  assert.equal(repairIban('ZZ82WEST12345698765432'), null, 'unknown country');
  assert.equal(repairIban(''), null);

  // A repaired value must always satisfy mod-97 === 1, by construction.
  const repaired = repairIban('GB28WEST12345698765432');
  assert.equal(repaired.iban, VALID.GB);
  assert.equal(validateIban(repaired.iban).valid, true);
});

test('wrong length for a known country is reported with the expected length', () => {
  const result = validateIban('DE893704004405320130');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /exactly 22 characters; received 20/);
});

test('unknown country code is named as such', () => {
  const result = validateIban('ZZ82WEST12345698765432');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /not in the IBAN registry/);
});

test('non-alphanumeric characters are rejected by name', () => {
  const result = validateIban('GB82-WEST-12345698765432');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /not letters or digits/);
});

test('shortest legal IBAN is Norway at 15 characters', () => {
  assert.equal(ibanLengthFor('NO'), 15);
  assert.equal(validateIban('NO938601111794').valid, false, '14 characters');
  assert.equal(validateIban('NO9386011117947').valid, true, '15 characters');
});

test('bank identifier is only reported where the registry defines one', () => {
  assert.equal(validateIban(VALID.DE).bankIdentifier, '37040044');
  assert.equal(validateIban('NO9386011117947').bankIdentifier, '8601');
});

test('never throws, whatever it is handed', () => {
  for (const input of [null, undefined, 42, {}, [], '', '   ', '💥', 'GB', 'A'.repeat(500)]) {
    const result = validateIban(input);
    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.length > 0);
  }
});

test('grouping in fours matches the ISO print format', () => {
  assert.equal(groupInFours(VALID.GB), 'GB82 WEST 1234 5698 7654 32');
  assert.equal(groupInFours(''), '');
});