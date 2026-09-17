/**
 * SEPA rule tests.
 *
 * These cover the checks that a plain IBAN validator does not make, which is
 * the whole reason this package exists as something other than a wrapper.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEPA_SCOPE, SEPA_TERRITORIES_WITHOUT_OWN_IBAN_PREFIX, isSepaCountry, ibanCountry,
  checkSepaCharset, checkRemittance, parseAmount, checkAmount, checkCurrency,
  checkBic, sepaPrefixHint, MAX_SEPA_AMOUNT,
} from '../lib/sepa.js';
import { supportedIbanCountries } from '../lib/iban.js';

/**
 * The SEPA scope list and the IBAN registry are two different things. Every
 * scope entry must either have an IBAN structure we can validate, or be one of
 * the documented Crown Dependency exceptions. This proves the two cannot drift.
 */
test('every SEPA scope entry is either validatable or a documented exception', () => {
  const known = new Set(supportedIbanCountries());
  const exceptions = new Set(SEPA_TERRITORIES_WITHOUT_OWN_IBAN_PREFIX);
  for (const code of SEPA_SCOPE) {
    assert.ok(
      known.has(code) || exceptions.has(code),
      `${code} is claimed as SEPA scope but has neither an IBAN registry entry nor a documented exception`,
    );
  }
  assert.equal(SEPA_SCOPE.length, 40);
});

test('the Crown Dependency exception is explained rather than left as a bare error', () => {
  assert.match(sepaPrefixHint('GG'), /no IBAN prefix of its own/);
  assert.match(sepaPrefixHint('JE'), /GB IBAN/);
  assert.equal(sepaPrefixHint('DE'), null);
  assert.equal(sepaPrefixHint('US'), null);
});

test('SEPA scope excludes non-participating IBAN countries', () => {
  assert.equal(isSepaCountry('DE'), true);
  assert.equal(isSepaCountry('de'), true);
  assert.equal(isSepaCountry('CH'), true, 'Switzerland is in scope');
  assert.equal(isSepaCountry('SM'), true, 'San Marino is in scope');
  assert.equal(isSepaCountry('US'), false);
  assert.equal(isSepaCountry('TR'), false);
  assert.equal(isSepaCountry(null), false);
});

test('country prefix reads through spaces', () => {
  assert.equal(ibanCountry('gb82 west 1234'), 'GB');
  assert.equal(ibanCountry('G'), null);
  assert.equal(ibanCountry(''), null);
});

test('EPC character set: names that banks accept pass', () => {
  for (const name of ['Ada Lovelace Ltd', 'Beispiel GmbH', "O'Brien Ltd", 'Muller-Praz (Suisse)', 'A+B / 3:4']) {
    const result = checkSepaCharset(name, 'Creditor name');
    assert.equal(result.ok, true, `${name} should pass: ${result.problems.join(' ')}`);
  }
});

test('ampersand and other common characters are outside the EPC set', () => {
  // This surprises people, so it is pinned deliberately: "&" is not in the
  // EPC character set for SEPA name and remittance fields, and a name carrying
  // one is a real defect in a payment file even though it is valid UTF-8.
  for (const bad of ['Handel & Zonen BV', 'Acme #1', 'Smith % Co', 'A*B', 'A@B']) {
    const result = checkSepaCharset(bad, 'Creditor name');
    assert.equal(result.ok, false, `${bad} must be rejected`);
  }
});

test('EPC character set: characters the scheme drops are named with a position', () => {
  const result = checkSepaCharset('Zürich Treuhand AG', 'Creditor name');
  assert.equal(result.ok, false);
  assert.equal(result.offences.length, 1);
  assert.equal(result.offences[0].char, 'ü');
  assert.equal(result.offences[0].index, 1);
  assert.match(result.problems[0], /position 2/);
});

test('separator and control characters are rejected', () => {
  assert.equal(checkSepaCharset('Acme\tBV', 'Creditor name').ok, false, 'tab');
  assert.equal(checkSepaCharset('Acme\nBV', 'Creditor name').ok, false, 'newline');
  assert.equal(checkSepaCharset('Acme  BV', 'Creditor name').ok, false, 'double space');
  assert.equal(checkSepaCharset(' Acme BV', 'Creditor name').ok, false, 'leading space');
  assert.equal(checkSepaCharset('Acme BV ', 'Creditor name').ok, false, 'trailing space');
  assert.equal(checkSepaCharset('<>', 'Creditor name').ok, false, 'no letters or digits');
});

test('remittance reference is capped at 140 characters', () => {
  assert.equal(checkRemittance('INV-2026-0001').ok, true);
  const long = checkRemittance('x'.repeat(141));
  assert.equal(long.ok, false);
  assert.match(long.problems[0], /141 characters/);
});

test('amounts are parsed in both European and English notation', () => {
  assert.equal(parseAmount('1250.00').cents, 125000);
  assert.equal(parseAmount('1250,00').cents, 125000);
  assert.equal(parseAmount('1.234,56').cents, 123456, 'dot as thousands separator');
  assert.equal(parseAmount('1,234.56').cents, 123456, 'comma as thousands separator');
  assert.equal(parseAmount('0.01').cents, 1);
});

test('an unparseable amount is refused rather than guessed', () => {
  for (const bad of ['', 'abc', '12,34,56', '1.2.3', '12.345']) {
    assert.equal(parseAmount(bad).ok, false, `${bad} must not parse`);
  }
});

test('amount rules reject zero, negatives and the ceiling breach', () => {
  assert.equal(checkAmount('0').ok, false);
  assert.equal(checkAmount('0,00').ok, false);
  assert.equal(checkAmount('-5').ok, false);
  assert.equal(checkAmount(String(MAX_SEPA_AMOUNT)).ok, true, 'exactly the ceiling is allowed');
  assert.equal(checkAmount('1000000000.00').ok, false);
  assert.equal(checkAmount('1250.00').ok, true);
});

test('a euro credit transfer must carry EUR', () => {
  assert.equal(checkCurrency('EUR').ok, true);
  assert.equal(checkCurrency('eur').ok, true);
  assert.equal(checkCurrency('USD').ok, false);
  assert.equal(checkCurrency('').ok, false);
});

test('BIC is optional inside SEPA but its country must match the account', () => {
  assert.equal(checkBic('').ok, true, 'IBAN-only is legitimate inside SEPA');
  assert.equal(checkBic('WESTGB22').ok, true, '8 characters is complete');
  assert.equal(checkBic('DEUTDEFF500').ok, true, '11 characters is complete');
  assert.equal(checkBic('WESTGB2').ok, false, '7 characters is short');
  assert.equal(checkBic('WESTG222').ok, false, 'country positions must be letters');

  const mismatch = checkBic('DEUTDEFF', 'GB82WEST12345698765432');
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.problems[0], /BIC country is DE but the account's IBAN country is GB/);

  assert.equal(checkBic('WESTGB22', 'GB82WEST12345698765432').ok, true);
});