/**
 * EU VAT number structure check - offline, no network.
 *
 * Ported from stream 01 (Numera)'s lib/vat.ts, minus the VIES lookup. This is
 * the offline half only: it answers "does this number have the right shape for
 * its member state", which is enough to catch a typo in a payment or invoice
 * file before it becomes a rejected reverse-charge claim.
 *
 * It deliberately does NOT answer "is this business registered for VAT". That
 * question has exactly one authoritative source, the European Commission's VIES
 * service, and that requires a network call. A package that quietly returned a
 * structural yes for a registration question would be worse than useless, so
 * the function name and the returned field name say "structure" and the
 * missing half is stated in the output.
 *
 * Correctness rule carried over from stream 01: an unknown member state and a
 * malformed number are different outcomes, and neither is reported as the
 * other.
 */

import { VAT_FORMATS, VAT_AREA_COUNT } from '../data/vat-formats.js';

export { VAT_AREA_COUNT };

/** Input aliases normalised to the code VIES itself uses. */
const COUNTRY_ALIASES = { GR: 'EL', UK: 'XI' };

/** Attribution shown alongside any VAT answer. */
export const VAT_SOURCE =
  'Structure from the national VAT number formats published by the European Commission. Registration status is not checked here - use VIES: https://ec.europa.eu/taxation_customs/vies/';

/** Remove spaces, dots, hyphens and slashes; uppercase. Never throws. */
export function normaliseVat(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[\s.\-/]/g, '').toUpperCase();
}

/** Every member-state code with a known national format, sorted. */
export function supportedVatCountries() {
  return Object.keys(VAT_FORMATS).sort();
}

/** The format description for a member state, or null when unknown. */
export function vatFormatFor(country) {
  const code = COUNTRY_ALIASES[String(country ?? '').toUpperCase()] ?? String(country ?? '').toUpperCase();
  const state = VAT_FORMATS[code];
  return state ? state.format : null;
}

/**
 * Check a VAT number against the national format of its member state.
 *
 * Returns { structurallyValid, country, number, format, registrationChecked,
 * source, errors }. `registrationChecked` is always false: this package never
 * contacts VIES, and saying so in the payload stops a caller mistaking a
 * structure check for a registration check.
 */
export function checkVatStructure(input) {
  const value = normaliseVat(input);
  const errors = [];
  const base = {
    structurallyValid: false,
    country: null,
    number: null,
    format: null,
    registrationChecked: false,
    source: VAT_SOURCE,
    errors,
  };

  if (value.length === 0) {
    errors.push('VAT number is empty. Provide a prefixed number, e.g. DE811907980.');
    return base;
  }

  const rawPrefix = value.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(rawPrefix)) {
    errors.push(`VAT number must start with a two-letter member-state prefix; received "${rawPrefix}".`);
    return base;
  }

  const country = COUNTRY_ALIASES[rawPrefix] ?? rawPrefix;
  const number = value.slice(2);
  const state = VAT_FORMATS[country];

  if (!state) {
    errors.push(`"${rawPrefix}" is not an EU VAT area prefix. This package covers the 27 member states plus XI (Northern Ireland), ${VAT_AREA_COUNT} areas in total.`);
    return { ...base, number };
  }

  const result = { ...base, country, number, format: state.format };

  if (number.length === 0) {
    errors.push(`VAT number for ${state.name} (${country}) is missing: expected ${state.format}.`);
    return result;
  }

  if (!state.pattern.test(number)) {
    errors.push(`"${number}" does not match the ${state.name} (${country}) VAT format: expected ${state.format}.`);
    return result;
  }

  result.structurallyValid = true;
  return result;
}