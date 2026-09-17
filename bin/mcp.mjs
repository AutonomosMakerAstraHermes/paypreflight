#!/usr/bin/env node
/**
 * paypreflight MCP server.
 *
 * Why this exists
 * ---------------
 * An agent that is asked to prepare or review a payment run should not be
 * guessing whether an IBAN is well formed, and it should not be handed a copy
 * of a creditor list. This server puts the same checks the CLI runs behind a
 * tool interface the agent can call, and it runs on the user's own machine over
 * stdio, so no file leaves the process.
 *
 * Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0. Implemented by hand
 * against the published protocol rather than with an SDK, because the package
 * promises zero dependencies and the surface used here is four methods.
 *
 * One rule matters more than the rest: nothing is ever written to stdout except
 * protocol messages. Any diagnostic goes to stderr, because a stray newline on
 * stdout corrupts the JSON-RPC stream and the client simply stops.
 */

import { readFileSync } from 'node:fs';
import { argv, stdin, stdout, stderr, exit } from 'node:process';

import { validateIban, groupInFours, repairIban, IBAN_COUNTRY_COUNT } from '../lib/iban.js';
import { checkVatStructure, VAT_AREA_COUNT } from '../lib/vat.js';
import { isSepaCountry, ibanCountry, sepaPrefixHint } from '../lib/sepa.js';
import { auditFile } from '../lib/index.js';

const VERSION = '0.1.0';
const PROTOCOL_FALLBACK = '2025-06-18';

const TOOLS = [
  {
    name: 'check_iban',
    description:
      'Validate a single IBAN offline against ISO 13616 (country format, length, and the ISO 7064 MOD 97-10 check digits). Returns whether it is valid, the country, the formatted form and the bank code where the registry defines one, whether the account is inside the SEPA geographical scope, and - when only the check digits are wrong - the exact corrected IBAN to use. No network call is made.',
    inputSchema: {
      type: 'object',
      properties: {
        iban: { type: 'string', description: 'The IBAN to check. Spaces and lowercase are fine.' },
      },
      required: ['iban'],
    },
  },
  {
    name: 'check_vat_structure',
    description:
      'Check whether an EU VAT number matches the national format of its member state (27 member states plus Northern Ireland, XI). Offline structure check only: it does NOT and cannot confirm registration, which requires the VIES service.',
    inputSchema: {
      type: 'object',
      properties: {
        vat: { type: 'string', description: 'The VAT number with its country prefix, e.g. DE811907980. Greece may be given as GR or EL.' },
      },
      required: ['vat'],
    },
  },
  {
    name: 'audit_payment_file',
    description:
      'Audit a full payment run and return a prioritised list of defects with fixes. Accepts CSV, JSON or ISO 20022 pain.001 XML as text. Checks every creditor IBAN, the EPC character set in names and remittance information, amounts and currency, BIC validity and consistency with the account country, whether the account is reachable under SEPA, duplicate instructions and duplicated remittance references, and - for pain.001 - whether the header control sum and instruction count still match the body. Everything runs locally; nothing is uploaded. Blocking defects are severity "error".',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The file contents as text. Preferred over path, because it needs no filesystem access.' },
        path: { type: 'string', description: 'Local path to read instead of passing content. Only used when content is absent; the file stays on this machine.' },
        known_ibans: {
          type: 'array',
          items: { type: 'string' },
          description: 'IBANs that have been paid before. Any other account in the run is reported as a first-time payee.',
        },
        currency: { type: 'string', description: 'Expected currency, default EUR.' },
      },
    },
  },
  {
    name: 'explain_checks',
    description:
      'Describe exactly which rules this server applies, and which it deliberately does not (VIES registration, bank account ownership, sanctions screening, XSD schema validation). Useful before relying on a result.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** Turn a tool result into MCP content. JSON keeps the report lossless. */
function jsonContent(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callCheckIban(args) {
  const iban = typeof args.iban === 'string' ? args.iban : '';
  const result = validateIban(iban);
  const country = ibanCountry(result.iban);
  const repaired = result.suggestedIban ?? null;

  if (!result.valid) {
    const hint = country ? sepaPrefixHint(country) : null;
    return jsonContent({
      valid: false,
      iban: result.iban,
      errors: result.errors,
      suggestedIban: repaired,
      suggestedFormatted: repaired ? groupInFours(repaired) : null,
      note: repaired
        ? 'The account digits are consistent; only the check digits fail. Confirm the account number before using the suggestion.'
        : 'This IBAN cannot be repaired from its own digits. Check the country prefix and the length.',
      ...(hint ? { hint } : {}),
    });
  }

  return jsonContent({
    valid: true,
    iban: result.iban,
    country: result.country,
    countryName: result.countryName,
    formatted: groupInFours(result.iban),
    bban: result.bban,
    bankIdentifier: result.bankIdentifier,
    sepaScope: isSepaCountry(country),
    note: isSepaCountry(country)
      ? 'Inside the SEPA geographical scope.'
      : `${result.countryName} is outside the SEPA geographical scope, so a euro credit transfer cannot reach this account.`,
  });
}

export { TOOLS, callCheckIban };
function callCheckVat(args) {
  const vat = typeof args.vat === 'string' ? args.vat : '';
  if (vat.trim() === '') return toolError('check_vat_structure needs a vat value, e.g. DE811907980.');

  const result = checkVatStructure(vat);
  return jsonContent({
    ...result,
    limitation: 'This is a format check. It does not confirm that the number is registered for VAT - only VIES can answer that.',
  });
}

async function callAuditPaymentFile(args) {
  let text = typeof args.content === 'string' ? args.content : null;

  if (text === null && typeof args.path === 'string') {
    try {
      text = readFileSync(args.path, 'utf8');
    } catch (error) {
      return toolError(`Could not read ${args.path}: ${error.message}`);
    }
  }
  if (text === null || text.trim() === '') {
    return toolError('audit_payment_file needs either content or path.');
  }

  const options = { source: typeof args.path === 'string' ? args.path : 'mcp-content' };
  if (typeof args.currency === 'string' && args.currency !== '') options.currency = args.currency;
  if (Array.isArray(args.known_ibans)) {
    options.knownIbans = new Set(
      args.known_ibans
        .filter((value) => typeof value === 'string')
        .map((value) => value.replace(/\s+/g, '').toUpperCase()),
    );
  }

  const report = await auditFile(text, options);

  // Row-by-row detail is large and rarely needed first; findings plus the
  // summary answer the question the agent actually asked. Rows are still
  // included so nothing is hidden behind a summary.
  return jsonContent({
    summary: report.summary,
    blocking: report.summary.blocking,
    findings: report.findings,
    suggestions: report.suggestions,
    firstTimePayees: report.firstTimePayees,
    columnsDetected: report.columns,
    ...(report.pain001 ? { pain001: report.pain001 } : {}),
    rows: report.rows,
  });
}

function callExplainChecks() {
  return jsonContent({
    checks: [
      'IBAN structure, per-country length, and ISO 7064 MOD 97-10 check digits (ISO 13616), offline.',
      'Corrected check digits when only the check digits fail.',
      'SEPA geographical scope reachability for each account country.',
      'EPC character set in creditor names and remittance information.',
      'Amount parse in European and English notation, greater than zero, below the scheme ceiling.',
      'Currency agreement with the expected currency.',
      'ISO 9362 BIC validity and country agreement with the account IBAN.',
      'Duplicate instructions (same IBAN, amount and date) and duplicated remittance references.',
      'First-time payees, when a reference list of previously paid IBANs is supplied.',
      'For pain.001: header and batch control sums against the instruction body, declared counts, identifier length, and missing IBAN/amount/currency elements.',
    ],
    doesNotCheck: [
      'VAT registration status (that is VIES, and it needs a network call this server does not make).',
      'Whether the creditor actually owns the account, or whether a name matches the account holder.',
      'Sanctions, PEP or adverse-media screening.',
      'XSD conformance of a pain.001 document.',
      'Whether a payment will succeed - only that the instruction is internally consistent and scheme-shaped.',
    ],
    coverage: { ibanCountryCodes: IBAN_COUNTRY_COUNT, vatAreas: VAT_AREA_COUNT },
  });
}

/** Dispatch one tools/call. Unknown tools throw, per the protocol. */
export async function callTool(name, args) {
  switch (name) {
    case 'check_iban': return callCheckIban(args ?? {});
    case 'check_vat_structure': return callCheckVat(args ?? {});
    case 'audit_payment_file': return callAuditPaymentFile(args ?? {});
    case 'explain_checks': return callExplainChecks();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

/** Build the JSON-RPC response for one incoming message, or null for a notification. */
export async function handleMessage(message) {
  const { id, method, params } = message ?? {};
  const isNotification = id === undefined || id === null;

  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const err = (code, messageText) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: messageText } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: 'paypreflight', version: VERSION },
        instructions:
          'Offline EU payment-run checks. Nothing leaves this machine. Use audit_payment_file on a payment file before it is sent to a bank; use explain_checks to see what is and is not verified.',
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ok({});

    case 'tools/list':
      return ok({ tools: TOOLS });

    case 'tools/call': {
      const name = params && params.name;
      try {
        return ok(await callTool(name, params && params.arguments));
      } catch (error) {
        return err(-32603, error.message);
      }
    }

    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

/**
 * Stdio transport: newline-delimited JSON-RPC 2.0.
 *
 * Buffered per line so a message split across chunks is reassembled, and
 * tolerant of a client that sends a blank line. Every diagnostic goes to
 * stderr - writing anything else to stdout would corrupt the protocol stream.
 */
function serve() {
  let buffer = '';

  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buffer += chunk;

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');

      if (line === '') continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        continue;
      }

      handleMessage(message)
        .then((response) => {
          if (response !== null) stdout.write(`${JSON.stringify(response)}\n`);
        })
        .catch((error) => {
          stderr.write(`paypreflight-mcp: ${error && error.message ? error.message : String(error)}\n`);
          if (message && message.id !== undefined && message.id !== null) {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' } })}\n`);
          }
        });
    }
  });

  stdin.on('end', () => exit(0));
  stdin.resume();
}

// Only start the server when run directly, so the module stays importable by
// tests without hijacking their stdin.
if (argv[1] && argv[1].replace(/\\/g, '/').endsWith('/mcp.mjs')) {
  serve();
  stderr.write(`paypreflight-mcp ${VERSION} listening on stdio\n`);
}