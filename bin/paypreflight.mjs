#!/usr/bin/env node
/**
 * paypreflight CLI.
 *
 * Runs entirely on the local machine: no upload, no account, no telemetry. That
 * is a product decision, not an implementation detail - the file being checked
 * is a creditor list, and for a finance team the ability to check it without
 * sending a copy of it to a third party is the difference between usable and
 * forbidden.
 *
 * Exit codes:
 *   0  nothing at or above the --fail-on threshold
 *   1  findings at or above the threshold
 *   2  usage error, unreadable file, or a cap that was exceeded
 *
 * The exit code is the CI contract: `paypreflight check suppliers.csv` in a
 * pre-payment step stops a bad run before it is uploaded to a bank.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stdout, stderr } from 'node:process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditFile } from '../lib/index.js';
import { formatReport, detectColumns } from '../lib/audit.js';
import { validateIban, groupInFours, repairIban } from '../lib/iban.js';
import { checkVatStructure } from '../lib/vat.js';
import { isSepaCountry, ibanCountry } from '../lib/sepa.js';
import { parseCsvToRecords, parseCsv } from '../lib/csv.js';
import { fixRun, describeChanges, toCsv } from '../lib/fix.js';
import { resolveLicence, TIER_LIMITS } from '../lib/licence.js';

const VERSION = '0.1.0';
const HERE = dirname(fileURLToPath(import.meta.url));

/** Rows audited without an explicit --max-rows. Covers the common case. */
const DEFAULT_MAX_ROWS = 5000;

const USAGE = `paypreflight ${VERSION} - pre-flight checks for an EU payment run

Usage
  paypreflight check <file> [options]    audit a CSV, JSON or pain.001 file
  paypreflight fix <file> [options]      show what to change, and with a Pro
                                         licence write the corrected CSV
  paypreflight iban <value>              check one IBAN, with a repair if the
                                         check digits are wrong
  paypreflight vat <value>               check one VAT number's structure
  paypreflight licence                   show which tier is in effect and why
  paypreflight mcp                       print the config snippet for an AI client
  paypreflight version

Options for check
  --json                 print the machine-readable report instead of text
  --known <file>         list of previously paid IBANs, one per line, to flag
                         first-time payees
  --currency <code>      expected currency, default EUR
  --max-rows <n>         audit at most n rows, default ${DEFAULT_MAX_ROWS}; a larger
                         file is refused rather than silently truncated
  --fail-on <level>      error (default) | warning | never
  --quiet                print nothing on success

Options for fix
  --out <file>           write the corrected CSV ("-" for stdout). Needs Pro.
  --licence <key>        licence key; alternatively set PAYPREFLIGHT_LICENCE and
                         PAYPREFLIGHT_LICENCE_SECRET
  --json                 print the change log as JSON

Examples
  paypreflight check suppliers.csv
  paypreflight check payments.xml --json > report.json
  paypreflight check run.csv --known paid-before.txt --fail-on warning
  paypreflight fix run.csv --out run-fixed.csv --licence PPF1.xxx.yyy
  paypreflight iban GB28WEST12345698765432

Exit codes
  0 clean, 1 findings at or above the threshold, 2 usage or limit error,
  3 a paid feature was requested without a licence

Nothing is uploaded. This tool has no network code at all.`;

/** Parse `--flag value` and `--flag` pairs. Unknown flags are an error. */
function parseArgs(args) {
  const flags = new Map();
  const positional = [];
  const withValue = new Set(['--known', '--currency', '--max-rows', '--fail-on', '--out', '--licence']);
  const bare = new Set(['--json', '--quiet', '--help', '-h']);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (withValue.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      flags.set(arg, value);
      i++;
    } else if (bare.has(arg)) {
      flags.set(arg, true);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}.`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/** Read a reference IBAN list: one per line, '#' comments, blanks ignored. */
function readKnownIbans(path) {
  const set = new Set();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (value === '' || value.startsWith('#')) continue;
    set.add(value.replace(/\s+/g, '').toUpperCase());
  }
  return set;
}

function fail(message, code = 2) {
  stderr.write(`paypreflight: ${message}\n`);
  exit(code);
}

async function commandCheck(positional, flags) {
  const file = positional[0];
  if (file === undefined) return fail('check needs a file. Run paypreflight --help.');

  const maxRows = flags.has('--max-rows') ? Number(flags.get('--max-rows')) : DEFAULT_MAX_ROWS;
  if (!Number.isFinite(maxRows) || maxRows <= 0) return fail('--max-rows must be a positive number.');

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return fail(`could not read ${file}: ${error.message}`);
  }

  const options = { source: file, currency: flags.get('--currency') ?? 'EUR', maxRows };
  if (flags.has('--known')) {
    try {
      options.knownIbans = readKnownIbans(flags.get('--known'));
    } catch (error) {
      return fail(`could not read the --known file: ${error.message}`);
    }
  }

  let report;
  try {
    report = await auditFile(text, options);
  } catch (error) {
    return fail(error.message);
  }

  // A truncated run must never look like a pass: the cap is a limit, not a
  // filter, and a clean report on the first N rows says nothing about the rest.
  if (report.summary.truncated) {
    stdout.write(flags.has('--json') ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
    return fail(`only the first ${maxRows} row(s) were audited. Re-run with a higher --max-rows to cover the whole file.`, 2);
  }

  if (flags.has('--json')) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (!flags.has('--quiet') || !report.summary.clean) stdout.write(`${formatReport(report)}\n`);

  const threshold = flags.get('--fail-on') ?? 'error';
  if (threshold === 'never') return 0;
  if (threshold === 'warning') return report.summary.errors > 0 || report.summary.warnings > 0 ? 1 : 0;
  if (threshold !== 'error') return fail(`--fail-on must be error, warning or never; received ${threshold}.`);
  return report.summary.blocking ? 1 : 0;
}

function commandIban(positional, flags) {
  const value = positional[0];
  if (value === undefined) return fail('iban needs a value.');

  const result = validateIban(value);
  const country = ibanCountry(result.iban);

  if (flags.has('--json')) {
    stdout.write(`${JSON.stringify({ ...result, sepaScope: country ? isSepaCountry(country) : null }, null, 2)}\n`);
  } else if (result.valid) {
    stdout.write(`${result.iban} is valid.\n`);
    stdout.write(`  country      ${result.countryName} (${result.country})\n`);
    stdout.write(`  formatted    ${groupInFours(result.iban)}\n`);
    stdout.write(`  BBAN         ${result.bban}\n`);
    if (result.bankIdentifier) stdout.write(`  bank code    ${result.bankIdentifier}\n`);
    stdout.write(`  SEPA         ${isSepaCountry(country) ? 'inside the SEPA geographical scope' : 'outside the SEPA geographical scope'}\n`);
  } else {
    stdout.write(`${result.iban === '' ? '(empty)' : result.iban} is not valid.\n`);
    for (const error of result.errors) stdout.write(`  ${error}\n`);
    const repaired = result.suggestedIban ?? (repairIban(result.iban) ? repairIban(result.iban).iban : null);
    if (repaired) {
      stdout.write(`\nIf the account digits are right, the check digits should be ${repaired.slice(2, 4)} and the IBAN is:\n  ${repaired}\n  ${groupInFours(repaired)}\n`);
    }
  }
  return result.valid ? 0 : 1;
}

function commandVat(positional, flags) {
  const value = positional[0];
  if (value === undefined) return fail('vat needs a value.');

  const result = checkVatStructure(value);
  if (flags.has('--json')) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.structurallyValid ? 0 : 1;
  }

  if (result.structurallyValid) {
    stdout.write(`${result.country}${result.number} has the right structure for ${result.country}.\n`);
    stdout.write(`  expected format  ${result.format}\n`);
  } else {
    stdout.write(`${value} does not pass the structure check.\n`);
    for (const error of result.errors) stdout.write(`  ${error}\n`);
  }
  stdout.write('  registration     not checked - this tool has no network code. Use VIES.\n');
  return result.structurallyValid ? 0 : 1;
}

/**
 * `fix` - turn findings into a corrected file.
 *
 * The free tier shows the diff; writing the corrected file needs a licence.
 * That split is deliberate and honest: the diagnosis is free and genuinely
 * useful, and the part that saves the hours - not having to hand-edit 400 rows -
 * is what a business pays for.
 */
function commandFix(positional, flags) {
  const file = positional[0];
  if (file === undefined) return fail('fix needs a file. Run paypreflight --help.');

  // resolveLicence(secret, explicitKey): the key may come from the flag, the
  // HMAC secret comes from the environment (a shared secret is never a flag,
  // which would leak it into shell history and process listings).
  const licence = resolveLicence(null, flags.get('--licence') ?? null);
  if (flags.get('--licence') && !licence.valid) {
    stderr.write(`paypreflight: licence not accepted: ${licence.reason}\n`);
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return fail(`could not read ${file}: ${error.message}`);
  }

  if (text.trimStart().startsWith('<')) {
    return fail('fix currently writes CSV only. Run `paypreflight check` on a pain.001 file to get the control-sum correction, then update the header.');
  }

  const { records, keys, headers, delimiter } = parseCsvToRecords(text);
  if (records.length === 0) return fail(`${file} contains no data rows.`);

  const maxRows = licence.limits.maxRows;
  if (records.length > maxRows) {
    return fail(`${file} has ${records.length} rows; the ${licence.limits.label} tier covers ${maxRows}. A Pro licence raises this with --licence <key>.`);
  }

  const columns = detectColumns(keys);
  const result = fixRun(records, columns);

  const out = flags.get('--out');
  // Any corrected output - a file, stdout via `--out -`, or the records inside
  // --json - is the paid deliverable. Only the human-readable diff is free,
  // whichever route is asked for.
  const wantsCorrected = out !== undefined || flags.has('--json');

  if (!licence.limits.writeFixes && wantsCorrected) {
    if (flags.has('--json')) {
      stdout.write(`${JSON.stringify({ licence: { tier: licence.tier, valid: licence.valid }, changes: result.changes, unfixable: result.unfixable, summary: result.summary, note: 'Corrected records need a Pro licence.' }, null, 2)}\n`);
    } else {
      stdout.write(`${describeChanges(result)}\n\n`);
      stdout.write(`Writing the corrected file needs a Pro licence. The diff above is free and complete.\n`);
      stdout.write(`Set --licence <key>, or PAYPREFLIGHT_LICENCE plus PAYPREFLIGHT_LICENCE_SECRET, to write it.\n`);
    }
    return 3;
  }

  if (flags.has('--json')) {
    stdout.write(`${JSON.stringify({ licence: { tier: licence.tier, valid: licence.valid }, ...result }, null, 2)}\n`);
  } else {
    stdout.write(`${describeChanges(result)}\n\n`);
  }

  if (out !== undefined) {
    // Records are keyed by the normalised header keys, not the original
    // header text. Writing with the original headers as keys would silently
    // produce empty cells, so map each record back through the key list.
    const serialize = () => {
      if (headers.length > 0) {
        const rows = result.records.map((record) =>
          Object.fromEntries(headers.map((header, index) => [header, record[keys[index]] ?? record[header] ?? ''])),
        );
        return toCsv(rows, headers, delimiter);
      }
      const fallbackKeys = Object.keys(result.records[0] ?? {}).filter((k) => k !== '__line');
      const rows = result.records.map(({ __line, ...rest }) => rest);
      return toCsv(rows, fallbackKeys, delimiter);
    };
    const output = serialize();
    if (out === '-') {
      stdout.write(output);
    } else {
      writeFileSync(out, output);
      stdout.write(`Wrote ${result.records.length} corrected row(s) to ${out}\n`);
    }
  }

  return result.unfixable.length > 0 ? 1 : 0;
}

/** `licence` - show which tier is in effect and why. */
function commandLicence(flags) {
  const licence = resolveLicence(null, flags.get('--licence') ?? null);
  stdout.write(`tier         ${licence.tier} (${licence.limits.label})\n`);
  stdout.write(`max rows     ${licence.limits.maxRows === Infinity ? 'unlimited' : licence.limits.maxRows}\n`);
  stdout.write(`write fixes  ${licence.limits.writeFixes ? 'yes' : 'no'}\n`);
  stdout.write(`why          ${licence.reason}\n`);
  if (licence.holder) stdout.write(`holder       ${licence.holder}\n`);
  if (licence.expires) stdout.write(`expires      ${licence.expires}\n`);
  return 0;
}

function commandMcp() {
  stdout.write(`Add this to your MCP client configuration (Claude Desktop, Cursor, Cline and others):

{
  "mcpServers": {
    "paypreflight": {
      "command": "node",
      "args": ["${HERE.replace(/\\/g, '/')}/mcp.mjs"]
    }
  }
}

Once the package is on npm, {"command": "npx", "args": ["-y", "paypreflight-mcp"]} is equivalent.
The server speaks stdio JSON-RPC 2.0 and never leaves the machine.`);
  return 0;
}

async function main() {
  const { flags, positional } = parseArgs(argv.slice(2));
  if (flags.has('--help') || flags.has('-h') || positional.length === 0) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  const [command, ...rest] = positional;
  switch (command) {
    case 'check': return commandCheck(rest, flags);
    case 'fix': return commandFix(rest, flags);
    case 'licence': return commandLicence(flags);
    case 'iban': return commandIban(rest, flags);
    case 'vat': return commandVat(rest, flags);
    case 'mcp': return commandMcp();
    case 'version': stdout.write(`${VERSION}\n`); return 0;
    default:
      stderr.write(`paypreflight: unknown command "${command}".\n\n${USAGE}\n`);
      return 2;
  }
}

try {
  exit(await main());
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}