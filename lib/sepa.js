/**
 * SEPA scheme rules that a field-level validator does not check.
 *
 * Why this file exists
 * --------------------
 * "Is this IBAN structurally valid?" is a solved, commoditised question - free
 * MIT libraries answer it offline, so a product cannot be built on it. What
 * actually stops a payment run is one layer up:
 *
 *   - an IBAN that is valid but not reachable under the SEPA scheme;
 *   - a name field containing characters the scheme does not carry;
 *   - an amount that is zero, negative, or above the scheme ceiling;
 *   - a currency that is not EUR in a euro credit transfer;
 *   - a BIC whose country disagrees with the account's country;
 *   - a remittance reference longer than the scheme allows.
 *
 * Those are the checks that produce rejected files, returned payments and
 * manual repair work, and they are all pure computation. No network, no
 * accounts, no third party seeing the file.
 *
 * Sources: the EPC SEPA geographical scope and the EPC recommendation on the
 * character set for SEPA payments, plus the ISO 9362 BIC definition.
 */

/**
 * EPC SEPA geographical scope, in IBAN-prefix terms.
 *
 * The 27 EU member states plus Iceland, Liechtenstein, Norway, Switzerland,
 * Monaco, San Marino, Andorra, Vatican City, the United Kingdom, Gibraltar and
 * the Crown Dependencies (Guernsey, Isle of Man, Jersey).
 *
 * Greece appears as GR here because that is the prefix on a Greek IBAN, even
 * though its VAT prefix is EL - the two schemes use different codes for the
 * same country, which is a classic source of file defects.
 */
export const SEPA_SCOPE = Object.freeze([
  'AD', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE',
  'ES', 'FI', 'FR', 'GB', 'GG', 'GI', 'GR', 'HR', 'HU', 'IE',
  'IM', 'IS', 'IT', 'JE', 'LI', 'LT', 'LU', 'LV', 'MC', 'MT',
  'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'SM', 'VA',
]);

const SEPA_SET = new Set(SEPA_SCOPE);

/**
 * SEPA territories that do not appear as their own prefix in the SWIFT IBAN
 * registry.
 *
 * Guernsey, the Isle of Man and Jersey are inside the EPC SEPA geographical
 * scope, but the IBAN registry publishes no separate structure for them: an
 * account in those territories carries a GB IBAN with a territory-specific
 * sort code. So GG/IM/JE appear in the scope list above and must never appear
 * as an IBAN prefix in a real file. Being explicit about this is what stops a
 * file containing "GG.." being waved through as a normal SEPA payment.
 *
 * This is asserted by the test suite, so the two lists cannot drift apart
 * silently.
 */
export const SEPA_TERRITORIES_WITHOUT_OWN_IBAN_PREFIX = Object.freeze(['GG', 'IM', 'JE']);

/** True when the country has no IBAN prefix of its own, only a GB account. */
export function isPrefixlessSepaTerritory(country) {
  return SEPA_TERRITORIES_WITHOUT_OWN_IBAN_PREFIX.includes(String(country ?? '').toUpperCase());
}

/**
 * A short explanation for a country code that looks like a SEPA prefix but is
 * not a valid IBAN prefix, or null when there is nothing useful to add.
 */
export function sepaPrefixHint(country) {
  const code = String(country ?? '').toUpperCase();
  if (isPrefixlessSepaTerritory(code)) {
    return `Note: ${code} is inside the SEPA geographical scope but has no IBAN prefix of its own - a creditor there is paid on a GB IBAN with a territory-specific sort code.`;
  }
  if (isSepaCountry(code)) return null;
  return null;
}

/** True when the country prefix is inside the EPC SEPA geographical scope. */
export function isSepaCountry(country) {
  return SEPA_SET.has(String(country ?? '').toUpperCase());
}

/** The country prefix of an IBAN, or null when there is none to read. */
export function ibanCountry(iban) {
  const value = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{2}/.test(value) ? value.slice(0, 2) : null;
}

/** Highest amount a single SEPA credit transfer instruction may carry. */
export const MAX_SEPA_AMOUNT = 999999999.99;

/**
 * The EPC character set: A-Z a-z 0-9 and / - ? : ( ) . , ' + and space,
 * with no leading or trailing space and no double space.
 */
const SEPA_ALLOWED = /^[A-Za-z0-9/\-?:().,'+ ]*$/;

/**
 * Check a name or remittance field against the EPC character set.
 *
 * Returns { ok, offences, problems } where offences names each disallowed
 * character with its position, so a report can say exactly what to delete
 * rather than "contains invalid characters".
 */
export function checkSepaCharset(value, field = 'field') {
  const text = String(value ?? '');
  const offences = [];
  for (let i = 0; i < text.length; i++) {
    if (!SEPA_ALLOWED.test(text[i])) offences.push({ index: i, char: text[i] });
  }
  const problems = offences.map(
    (o) => `${field} contains ${JSON.stringify(o.char)} at position ${o.index + 1}, which the SEPA character set does not carry.`,
  );

  if (text !== text.trim()) problems.push(`${field} has leading or trailing whitespace.`);
  if (/ {2}/.test(text)) problems.push(`${field} contains a double space.`);
  if (text.length > 0 && problems.length === 0 && !/[A-Za-z0-9]/.test(text)) {
    problems.push(`${field} contains no letters or digits.`);
  }
  return { ok: problems.length === 0, offences, problems };
}

/** Check a remittance information field: 140 characters is the scheme ceiling. */
export function checkRemittance(value, maxLength = 140) {
  const text = String(value ?? '');
  const problems = [];
  if (text.length > maxLength) {
    problems.push(`Remittance information is ${text.length} characters; the scheme allows ${maxLength}.`);
  }
  const charset = checkSepaCharset(text, 'Remittance information');
  return { ok: problems.length === 0 && charset.ok, problems: [...problems, ...charset.problems] };
}

/**
 * Parse a decimal amount written the way payment files write it.
 *
 * Accepts "1234.56", "1234,56" and "1.234,56" - the last is what a German or
 * Dutch export produces, and reading it as 1.234 would silently understate a
 * payment by three orders of magnitude. The caller gets back the raw string it
 * supplied alongside the parsed cents so a report can show both.
 */
export function parseAmount(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return { ok: false, cents: null, raw, problems: ['Amount is empty.'] };

  // A comma is a decimal separator unless a dot follows it, in which case the
  // comma was a thousands separator.
  let normalised = raw;
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) normalised = raw.replace(/\./g, '').replace(',', '.');
    else normalised = raw.replace(/,/g, '');
  } else if (lastComma !== -1) {
    normalised = raw.replace(',', '.');
  }

  if (!/^-?\d+(\.\d+)?$/.test(normalised)) {
    return { ok: false, cents: null, raw, problems: [`Amount ${JSON.stringify(raw)} is not a number.`] };
  }
  const decimals = normalised.split('.')[1] ?? '';
  if (decimals.length > 2) {
    return { ok: false, cents: null, raw, problems: [`Amount ${JSON.stringify(raw)} has more than two decimal places.`] };
  }
  return { ok: true, cents: Math.round(Number(normalised) * 100), raw, normalised };
}

/** Validate an amount against the SEPA rules. Zero and negative are rejected. */
export function checkAmount(value) {
  const parsed = parseAmount(value);
  if (!parsed.ok) return { ok: false, cents: null, problems: parsed.problems };
  const problems = [];
  if (parsed.cents <= 0) problems.push(`Amount ${parsed.raw} must be greater than zero.`);
  if (parsed.cents > Math.round(MAX_SEPA_AMOUNT * 100)) {
    problems.push(`Amount ${parsed.raw} exceeds the scheme ceiling of ${MAX_SEPA_AMOUNT}.`);
  }
  return { ok: problems.length === 0, cents: parsed.cents, problems };
}

/** A euro credit transfer carries EUR. Anything else is a different scheme. */
export function checkCurrency(value, expected = 'EUR') {
  const text = String(value ?? '').trim().toUpperCase();
  if (text === '') return { ok: false, problems: ['Currency is empty.'] };
  if (text !== expected) {
    return { ok: false, problems: [`Currency is ${text}; a ${expected} credit transfer must carry ${expected}.`] };
  }
  return { ok: true, problems: [] };
}

/**
 * ISO 9362 BIC: 4 letters of institution code, 2 letters of country, 2
 * alphanumeric location characters, then an optional 3-alphanumeric branch.
 */
const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;

/**
 * Validate a BIC and, when an IBAN is supplied, that the two agree on country.
 *
 * Only the country positions can be cross-checked reliably: the institution
 * portion of a BIC does not map to the BBAN bank identifier for most countries
 * (Germany's bank code is numeric, France's structure is not aligned), so this
 * deliberately does not attempt to derive or confirm the bank itself.
 */
export function checkBic(value, iban = null) {
  const text = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  const problems = [];

  if (text === '') {
    return {
      ok: true,
      bic: '',
      problems,
      note: 'No BIC supplied. SEPA accepts an IBAN-only creditor account, so this is not a defect inside the SEPA scope.',
    };
  }
  if (!BIC_PATTERN.test(text)) {
    problems.push(`${text} is not a valid ISO 9362 BIC: expected 4 letters of institution code, 2 letters of country, 2 alphanumeric location characters, then an optional 3-character branch.`);
    return { ok: false, bic: text, problems };
  }

  const bicCountry = text.slice(4, 6);
  const accountCountry = ibanCountry(iban);
  if (accountCountry && bicCountry !== accountCountry) {
    problems.push(`BIC country is ${bicCountry} but the account's IBAN country is ${accountCountry}. These must agree.`);
  }
  return { ok: problems.length === 0, bic: text, problems };
}