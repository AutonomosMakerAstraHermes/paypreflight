/**
 * ISO 13616 IBAN validation - fully offline, zero network calls.
 *
 * Ported from stream 01 (Numera)'s lib/iban.ts, which is the implementation
 * that has been validating live traffic. The algorithm is unchanged:
 *
 *   1. Normalise: strip every whitespace character, uppercase.
 *   2. Reject anything that is not [A-Z0-9], or shorter than 15 characters.
 *   3. Look the two-letter country prefix up in the length registry and require
 *      an exact length match - IBAN lengths are fixed per country.
 *   4. Rotate: move the first four characters to the end.
 *   5. Expand: digits stay, letters become their position plus 9 (A=10..Z=35).
 *   6. Remainder modulo 97 by chunked division, so the intermediate value never
 *      exceeds nine digits - no BigInt, constant memory, no precision loss.
 *   7. Valid if and only if the remainder is exactly 1 (ISO 7064 MOD 97-10).
 *
 * Nothing here throws. Malformed input returns { valid: false, errors: [...] }
 * with a specific, human-readable reason.
 */

import { IBAN_REGISTRY, IBAN_COUNTRY_COUNT } from '../data/iban-registry.js';

export { IBAN_COUNTRY_COUNT };

const ALLOWED_CHARS = /^[A-Z0-9]+$/;
const COUNTRY_PREFIX = /^[A-Z]{2}$/;
const CHECK_DIGITS = /^[0-9]{2}$/;

/** Strip every whitespace character and uppercase. Never throws. */
export function normaliseIban(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, '').toUpperCase();
}

/** Group in blocks of four separated by single spaces - the ISO print format. */
export function groupInFours(value) {
  const groups = value.match(/.{1,4}/g);
  return groups ? groups.join(' ') : '';
}

/**
 * Expand into numeric form: digits pass through, letters become their alphabet
 * position plus 9 (A=10 ... Z=35). Null if any character is outside [A-Z0-9].
 */
function toDigits(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 48 && code <= 57) out += value[i];
    else if (code >= 65 && code <= 90) out += String(code - 55);
    else return null;
  }
  return out;
}

/**
 * ISO 7064 MOD 97-10 remainder, computed by chunked division.
 *
 * Each step prefixes the running remainder (at most two digits, 0-96) to the
 * next seven digits, giving a nine-digit operand at most - far inside the 2^53
 * exact-integer range. No BigInt is ever constructed.
 */
export function mod97(digits) {
  let remainder = 0;
  for (let i = 0; i < digits.length; i += 7) {
    remainder = Number(String(remainder) + digits.slice(i, i + 7)) % 97;
  }
  return remainder;
}

/** Every country prefix this package can validate, sorted alphabetically. */
export function supportedIbanCountries() {
  return Object.keys(IBAN_REGISTRY).sort();
}

/** Expected total IBAN length for a country prefix, or null if unknown. */
export function ibanLengthFor(country) {
  const spec = IBAN_REGISTRY[String(country).toUpperCase()];
  return spec ? spec.length : null;
}

/** The registry entry for a country prefix, or null. */
export function ibanSpecFor(country) {
  return IBAN_REGISTRY[String(country).toUpperCase()] ?? null;
}

/**
 * The two check digits that make `country + bban` satisfy ISO 7064 MOD 97-10.
 *
 * This is what turns a rejection into a fix: a payment run that fails only on
 * check digits is one character-pair away from being payable, and a report that
 * says "expected 82, found 28" is actionable where "checksum failed" is not.
 */
export function checkDigitsFor(country, bban) {
  const value = String(bban).toUpperCase() + String(country).toUpperCase();
  // Order matters: ISO 7064 for an IBAN is computed over "BBAN + country + 00",
  // not "country + BBAN + 00". Getting this backwards still produces two digits,
  // and they are wrong, which is why repairIban() verifies its own output.
  const remainder = mod97(String(toDigits(value + '00')));
  const check = 98 - remainder;
  return check < 10 ? `0${check}` : String(check);
}

/**
 * Validate an IBAN offline against ISO 13616.
 * Always returns a result object; never throws, whatever the input.
 */
export function validateIban(input) {
  const iban = normaliseIban(input);
  const errors = [];

  const result = {
    valid: false,
    iban,
    country: null,
    countryName: null,
    checkDigits: null,
    bban: null,
    bankIdentifier: null,
    formatted: groupInFours(iban),
    errors,
  };

  if (iban.length === 0) {
    errors.push('IBAN is empty. Provide a string of letters and digits, e.g. DE89370400440532013000.');
    return result;
  }

  if (!ALLOWED_CHARS.test(iban)) {
    const bad = Array.from(new Set(iban.split('').filter((c) => !/[A-Z0-9]/.test(c))));
    errors.push(`IBAN contains character(s) that are not letters or digits: ${bad.map((c) => JSON.stringify(c)).join(', ')}.`);
    return result;
  }

  if (iban.length < 15) {
    errors.push(`IBAN is ${iban.length} character(s) long; the shortest possible IBAN is 15 characters (Norway).`);
    return result;
  }

  const country = iban.slice(0, 2);
  result.country = country;

  if (!COUNTRY_PREFIX.test(country)) {
    errors.push(`IBAN must start with a two-letter ISO 3166-1 country code; received "${country}".`);
    return result;
  }

  const spec = IBAN_REGISTRY[country];
  if (!spec) {
    errors.push(`Country code "${country}" is not in the IBAN registry. This package knows ${IBAN_COUNTRY_COUNT} country codes.`);
    return result;
  }
  result.countryName = spec.name;

  const checkDigits = iban.slice(2, 4);
  if (!CHECK_DIGITS.test(checkDigits)) {
    errors.push(`Characters 3-4 must be the two numeric check digits; received "${checkDigits}".`);
    return result;
  }
  result.checkDigits = checkDigits;

  if (iban.length !== spec.length) {
    errors.push(`${spec.name} (${country}) IBANs are exactly ${spec.length} characters; received ${iban.length}.`);
    const repaired = repairIban(iban);
    if (repaired) result.suggestedIban = repaired.iban;
    return result;
  }

  const bban = iban.slice(4);
  result.bban = bban;
  if (spec.bank) {
    const [offset, len] = spec.bank;
    result.bankIdentifier = bban.slice(offset, offset + len);
  }

  const digits = toDigits(iban.slice(4) + iban.slice(0, 4));
  if (digits === null) {
    errors.push('IBAN could not be expanded to its numeric form.');
    return result;
  }

  const remainder = mod97(digits);
  if (remainder !== 1) {
    errors.push(`Checksum failed: ISO 7064 MOD 97-10 remainder is ${remainder}, expected 1. The check digits "${checkDigits}" do not match the account number.`);
    const repaired = repairIban(iban);
    if (repaired) result.suggestedIban = repaired.iban;
    return result;
  }

  result.valid = true;
  return result;
}

/**
 * Rebuild the IBAN that the given BBAN implies, i.e. supply correct check
 * digits. Returns null when the country or BBAN is not usable, so a caller can
 * never be handed a "repaired" IBAN that does not actually validate.
 */
export function repairIban(input) {
  const iban = normaliseIban(input);
  if (iban.length < 5 || !COUNTRY_PREFIX.test(iban.slice(0, 2))) return null;
  const country = iban.slice(0, 2);
  const spec = IBAN_REGISTRY[country];
  if (!spec) return null;

  const bban = iban.slice(4);
  const check = checkDigitsFor(country, bban);
  const repaired = country + check + bban;
  if (repaired.length !== spec.length) return null;
  if (!ALLOWED_CHARS.test(repaired)) return null;
  if (mod97(toDigits(repaired.slice(4) + repaired.slice(0, 4))) !== 1) return null;
  return { country, checkDigits: check, iban: repaired, formatted: groupInFours(repaired) };
}