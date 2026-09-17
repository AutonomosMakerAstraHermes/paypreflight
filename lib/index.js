/**
 * Public surface of paypreflight.
 *
 * Everything a caller needs is re-exported here, so a consumer has one import
 * and one place to look. The sub-entries in package.json's "exports" map expose
 * the same modules individually for tree-shaken bundling.
 */

export {
  validateIban, checkDigitsFor, repairIban, mod97, groupInFours,
  normaliseIban, supportedIbanCountries, ibanLengthFor, ibanSpecFor,
  IBAN_COUNTRY_COUNT,
} from './iban.js';

export {
  SEPA_SCOPE, SEPA_TERRITORIES_WITHOUT_OWN_IBAN_PREFIX, MAX_SEPA_AMOUNT,
  isSepaCountry, isPrefixlessSepaTerritory, sepaPrefixHint, ibanCountry,
  checkSepaCharset, checkRemittance, parseAmount, checkAmount, checkCurrency, checkBic,
} from './sepa.js';

export {
  VAT_SOURCE, VAT_AREA_COUNT, checkVatStructure, normaliseVat,
  supportedVatCountries, vatFormatFor,
} from './vat.js';

export { parseCsv, parseCsvToRecords, detectDelimiter } from './csv.js';

export {
  auditPaymentRun, auditRow, readRow, detectColumns, formatReport, SEVERITY_ORDER,
} from './audit.js';

export { parsePain001, auditPain001, toCents } from './pain001.js';

/**
 * Read a payment file and audit it, choosing the reader from the content
 * rather than the extension.
 *
 * XML is detected from the document itself because these files arrive renamed,
 * gzipped, exported from a bank portal as .txt, and pasted into tickets. Trust
 * the bytes, not the filename.
 */
export async function auditFile(text, options = {}) {
  const trimmed = String(text ?? '').replace(/^\uFEFF/, '').trimStart();

  if (trimmed.startsWith('<')) {
    const { auditPain001 } = await import('./pain001.js');
    return auditPain001(text, options);
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const { auditPaymentRun } = await import('./audit.js');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`The input looks like JSON but could not be parsed: ${error.message}`);
    }
    const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : null;
    if (records === null) {
      throw new Error('JSON input must be an array of records, or an object with a "records" array.');
    }
    return auditPaymentRun(records.map((record, index) => ({ __line: index + 1, ...record })), {
      ...options,
      source: options.source ?? 'json',
    });
  }

  const { parseCsvToRecords } = await import('./csv.js');
  const { auditPaymentRun } = await import('./audit.js');
  const { records } = parseCsvToRecords(text);
  return auditPaymentRun(records, { ...options, source: options.source ?? 'csv' });
}