/**
 * Port the already-tested IBAN registry and VAT format tables out of stream 01
 * (Numera) into this zero-dependency package, as plain ES modules.
 *
 * Why extract rather than retype
 * ------------------------------
 * The two source files are the ones actually exercised by Numera's test suite
 * against live traffic, so they are the copy of record. Retyping the tables by
 * hand would create a second, silently divergent copy of the same facts - the
 * exact failure mode the sibling streams were written to avoid.
 *
 * How it works
 * ------------
 * Both tables are plain object literals wrapped in a TypeScript type
 * annotation. This tool slices each literal out of the source text, drops the
 * annotation (the only TypeScript in the way), and evaluates the remainder as
 * JavaScript. Nothing is inferred and nothing is guessed: if the literals ever
 * stop being plain objects this tool throws instead of emitting a
 * plausible-looking but wrong table.
 *
 * Extraction is asserted against the counts Numera's own /api/v1/health
 * endpoint reports for the live deployment (116 IBAN country codes, 28 VAT
 * areas), so a truncated or renamed table fails loudly here.
 *
 * Usage:  node tools/port-validators.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const SRC = 'C:/Users/LauroM/hermes-revenue/streams/01-numera/lib';

/** Expected sizes, taken from https://01-numera.vercel.app/api/v1/health. */
const EXPECTED_IBAN_COUNTRIES = 116;
const EXPECTED_VAT_AREAS = 28;

/**
 * Slice a `const NAME ... = { ... };` object literal out of a source file and
 * evaluate it. Throws if the literal is missing, unbalanced or not a plain
 * object.
 */
function evalObjectLiteral(source, marker, file) {
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`${file}: could not find "${marker}". The source layout changed; fix this tool rather than guessing.`);
  }

  const literalStart = source.indexOf('{', start);
  if (literalStart === -1) throw new Error(`${file}: no object literal after "${marker}".`);

  // Walk braces, skipping string and regex literals, to find the matching close.
  let depth = 0;
  let end = -1;
  let quote = null;
  let inRegex = false;
  for (let i = literalStart; i < source.length; i++) {
    const c = source[i];
    const prev = source[i - 1];

    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (inRegex) {
      if (c === '\\') i++;
      else if (c === '/') inRegex = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && /[=(:,[]/.test(prev ?? '')) { inRegex = true; continue; }

    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`${file}: unbalanced braces in "${marker}" literal.`);

  const text = source.slice(literalStart, end);
  const value = new Function(`"use strict"; return (${text});`)();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: "${marker}" did not evaluate to a plain object.`);
  }
  return value;
}

/** Escape a string for embedding inside single quotes in generated JS. */
const sq = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function portIbanRegistry() {
  const file = join(SRC, 'iban.ts');
  const source = readFileSync(file, 'utf8');
  const registry = evalObjectLiteral(source, 'const REGISTRY', file);

  const codes = Object.keys(registry).sort();
  if (codes.length !== EXPECTED_IBAN_COUNTRIES) {
    throw new Error(`IBAN registry has ${codes.length} entries, expected ${EXPECTED_IBAN_COUNTRIES}.`);
  }

  const rows = [];
  for (const code of codes) {
    const spec = registry[code];
    if (!/^[A-Z]{2}$/.test(code)) throw new Error(`Bad IBAN country code: ${code}`);
    if (!Number.isInteger(spec.length) || spec.length < 15 || spec.length > 34) {
      throw new Error(`${code}: implausible IBAN length ${spec.length}`);
    }
    let bank = 'null';
    if (spec.bank !== null && spec.bank !== undefined) {
      const [offset, length] = spec.bank;
      if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) {
        throw new Error(`${code}: bad bank identifier position ${JSON.stringify(spec.bank)}`);
      }
      bank = `[${offset}, ${length}]`;
    }
    rows.push(`  ${code}: { length: ${spec.length}, name: '${sq(spec.name)}', bank: ${bank} },`);
  }

  const body = `/**
 * IBAN country registry - GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Produced by tools/port-validators.mjs from the registry that stream 01
 * (Numera) validates live traffic against. Source of truth: the SWIFT IBAN
 * Registry (ISO 13616-2), which fixes both the total length and the BBAN
 * structure of every participating country.
 *
 * \`bank\` is the [offset, length] of the national bank identifier inside the
 * BBAN, or null where the registry publishes no standard position. When it is
 * null this package reports the BBAN and does not guess at a bank code.
 *
 * Regenerate:  node tools/port-validators.mjs   (asserts ${EXPECTED_IBAN_COUNTRIES} entries)
 */

export const IBAN_REGISTRY = {
${rows.join('\n')}
};

/** Number of country codes with a defined IBAN format. */
export const IBAN_COUNTRY_COUNT = Object.keys(IBAN_REGISTRY).length;
`;
  writeFileSync(join(pkgRoot, 'data', 'iban-registry.js'), body);
  return codes.length;
}

function portVatFormats() {
  const file = join(SRC, 'vat.ts');
  const source = readFileSync(file, 'utf8');
  const states = evalObjectLiteral(source, 'const MEMBER_STATES', file);

  const codes = Object.keys(states).sort();
  if (codes.length !== EXPECTED_VAT_AREAS) {
    throw new Error(`VAT table has ${codes.length} entries, expected ${EXPECTED_VAT_AREAS}.`);
  }

  const rows = [];
  for (const code of codes) {
    const state = states[code];
    if (!/^[A-Z]{2}$/.test(code)) throw new Error(`Bad VAT country code: ${code}`);
    if (!(state.pattern instanceof RegExp)) throw new Error(`${code}: pattern is not a RegExp.`);
    if (typeof state.format !== 'string' || state.format.length === 0) {
      throw new Error(`${code}: missing human-readable format description.`);
    }
    rows.push(
      `  ${code}: { name: '${sq(state.name)}', pattern: new RegExp('${sq(state.pattern.source)}', '${state.pattern.flags}'), format: '${sq(state.format)}' },`,
    );
  }

  const body = `/**
 * EU VAT number formats per member state - GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Produced by tools/port-validators.mjs from the table that stream 01 (Numera)
 * validates against. Source of truth: the national VAT number formats published
 * by the European Commission. 27 member states plus XI (Northern Ireland, which
 * remained inside the EU VAT area for goods under the Windsor Framework).
 * Greece is keyed EL because that is the code VIES itself uses.
 *
 * Regenerate:  node tools/port-validators.mjs   (asserts ${EXPECTED_VAT_AREAS} VAT areas)
 */

export const VAT_FORMATS = {
${rows.join('\n')}
};

/** Number of VAT areas with a defined national format. */
export const VAT_AREA_COUNT = Object.keys(VAT_FORMATS).length;
`;
  writeFileSync(join(pkgRoot, 'data', 'vat-formats.js'), body);
  return codes.length;
}

mkdirSync(join(pkgRoot, 'data'), { recursive: true });
const ibanCount = portIbanRegistry();
const vatCount = portVatFormats();
console.log(`ported ${ibanCount} IBAN country codes and ${vatCount} VAT areas`);