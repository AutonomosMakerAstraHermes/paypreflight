/**
 * EU VAT number formats per member state - GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Produced by tools/port-validators.mjs from the table that stream 01 (Numera)
 * validates against. Source of truth: the national VAT number formats published
 * by the European Commission. 27 member states plus XI (Northern Ireland, which
 * remained inside the EU VAT area for goods under the Windsor Framework).
 * Greece is keyed EL because that is the code VIES itself uses.
 *
 * Regenerate:  node tools/port-validators.mjs   (asserts 28 VAT areas)
 */

export const VAT_FORMATS = {
  AT: { name: 'Austria', pattern: new RegExp('^U\\d{8}$', ''), format: 'U followed by 8 digits' },
  BE: { name: 'Belgium', pattern: new RegExp('^[01]\\d{9}$', ''), format: '10 digits starting with 0 or 1' },
  BG: { name: 'Bulgaria', pattern: new RegExp('^\\d{9,10}$', ''), format: '9 or 10 digits' },
  CY: { name: 'Cyprus', pattern: new RegExp('^\\d{8}[A-Z]$', ''), format: '8 digits followed by 1 letter' },
  CZ: { name: 'Czechia', pattern: new RegExp('^\\d{8,10}$', ''), format: '8, 9 or 10 digits' },
  DE: { name: 'Germany', pattern: new RegExp('^\\d{9}$', ''), format: '9 digits' },
  DK: { name: 'Denmark', pattern: new RegExp('^\\d{8}$', ''), format: '8 digits' },
  EE: { name: 'Estonia', pattern: new RegExp('^\\d{9}$', ''), format: '9 digits' },
  EL: { name: 'Greece', pattern: new RegExp('^\\d{9}$', ''), format: '9 digits' },
  ES: { name: 'Spain', pattern: new RegExp('^(?:[A-Z]\\d{7}[A-Z0-9]|\\d{8}[A-Z])$', ''), format: 'letter + 7 digits + letter/digit, or 8 digits + letter' },
  FI: { name: 'Finland', pattern: new RegExp('^\\d{8}$', ''), format: '8 digits' },
  FR: { name: 'France', pattern: new RegExp('^[A-HJ-NP-Z0-9]{2}\\d{9}$', ''), format: '2 characters (letters excluding I, O) followed by 9 digits' },
  HR: { name: 'Croatia', pattern: new RegExp('^\\d{11}$', ''), format: '11 digits' },
  HU: { name: 'Hungary', pattern: new RegExp('^\\d{8}$', ''), format: '8 digits' },
  IE: { name: 'Ireland', pattern: new RegExp('^(?:\\d{7}[A-W]|[7-9][A-Z*+]\\d{5}[A-W]|\\d{7}[A-W][A-IW])$', ''), format: '7 digits + letter, or the old 8-character and new 9-character forms' },
  IT: { name: 'Italy', pattern: new RegExp('^\\d{11}$', ''), format: '11 digits' },
  LT: { name: 'Lithuania', pattern: new RegExp('^(?:\\d{9}|\\d{12})$', ''), format: '9 or 12 digits' },
  LU: { name: 'Luxembourg', pattern: new RegExp('^\\d{8}$', ''), format: '8 digits' },
  LV: { name: 'Latvia', pattern: new RegExp('^\\d{11}$', ''), format: '11 digits' },
  MT: { name: 'Malta', pattern: new RegExp('^\\d{8}$', ''), format: '8 digits' },
  NL: { name: 'Netherlands', pattern: new RegExp('^\\d{9}B\\d{2}$', ''), format: '9 digits, the letter B, then 2 digits' },
  PL: { name: 'Poland', pattern: new RegExp('^\\d{10}$', ''), format: '10 digits' },
  PT: { name: 'Portugal', pattern: new RegExp('^\\d{9}$', ''), format: '9 digits' },
  RO: { name: 'Romania', pattern: new RegExp('^\\d{2,10}$', ''), format: '2 to 10 digits' },
  SE: { name: 'Sweden', pattern: new RegExp('^\\d{10}01$', ''), format: '12 digits ending in 01' },
  SI: { name: 'Slovenia', pattern: new RegExp('^\\d{8}$', ''), format: '8 digits' },
  SK: { name: 'Slovakia', pattern: new RegExp('^\\d{10}$', ''), format: '10 digits' },
  XI: { name: 'Northern Ireland', pattern: new RegExp('^(?:\\d{9}|\\d{12}|(?:GD|HA)\\d{3})$', ''), format: '9 or 12 digits, or GD/HA followed by 3 digits' },
};

/** Number of VAT areas with a defined national format. */
export const VAT_AREA_COUNT = Object.keys(VAT_FORMATS).length;
