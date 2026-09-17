/**
 * ISO 20022 pain.001 reader.
 *
 * Scope, stated plainly
 * ---------------------
 * This reads a pain.001 customer credit transfer initiation the way a finance
 * team edits one: it pulls the header control figures and the transaction
 * blocks out of the document, then hands the transactions to the shared audit
 * engine as ordinary records. It is a *consistency* reader, not an XSD schema
 * validator. It does not validate against the official message schema and it
 * does not handle arbitrary XML extensions.
 *
 * That boundary is deliberate. A schema validator answers "is this document
 * conformant"; the expensive failures in practice are the ones a schema cannot
 * see: a control sum that stopped matching after a hand edit, an IBAN with
 * transposed digits, a payee name carrying a character the scheme drops, a
 * first-time payee.
 *
 * Rather than pull in an XML dependency - which would break both the
 * zero-dependency promise and the browser build - elements are read by
 * namespace-tolerant tag matching. Namespace prefixes (`ns:CdtTrfTxInf`) are
 * accepted, CDATA is unwrapped, the five XML entities are decoded, and any
 * element that cannot be found is reported as missing rather than treated as
 * empty-but-fine.
 */

import { auditPaymentRun } from './audit.js';

/** Decode the five predefined XML entities plus numeric character references. */
function decodeXml(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

/** Collect every block for a tag, namespace prefix ignored, nesting ignored. */
function blocks(xml, tag) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'g');
  const found = [];
  let match;
  while ((match = pattern.exec(xml)) !== null) found.push(match[1]);
  return found;
}

/** Text of the first occurrence of a tag anywhere in the given fragment. */
function text(xml, tag) {
  const found = blocks(xml, tag);
  return found.length > 0 ? decodeXml(found[0]) : null;
}

/** An element with a Ccy attribute, e.g. <InstdAmt Ccy="EUR">1200.00</InstdAmt>. */
function attributedAmount(xml, tag) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}((?:\\s[^>]*)?)>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`);
  const match = pattern.exec(xml);
  if (match === null) return null;
  const ccy = /\bCcy\s*=\s*"([^"]*)"/.exec(match[1]);
  return { amount: decodeXml(match[2]), currency: ccy ? ccy[1].toUpperCase() : null };
}

/**
 * Turn a decimal string into integer cents by string arithmetic.
 *
 * Number(decimal) * 100 introduces binary rounding noise on values that are
 * exact in decimal, and this figure is compared against a control sum, so a
 * one-cent drift would produce a false mismatch.
 */
function toCents(decimal) {
  if (decimal === null || decimal === undefined) return null;
  const value = String(decimal).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export { toCents, decodeXml, blocks, text };

/**
 * Parse a pain.001 document.
 *
 * Returns { header, records, issues, transactionCount }.
 * `issues` holds document-level defects that are not about a single payment
 * instruction, so they can be reported alongside the row-level findings.
 */
export function parsePain001(xml) {
  const source = String(xml ?? '');
  const issues = [];
  const addIssue = (code, severity, message) => issues.push({ code, severity, message });

  const groupHeader = blocks(source, 'GrpHdr')[0];
  if (groupHeader === undefined) {
    addIssue('pain001_no_header', 'error', 'No GroupHeader (GrpHdr) element found. This does not look like a pain.001 document.');
  }

  const msgId = groupHeader === undefined ? null : text(groupHeader, 'MsgId');
  if (groupHeader !== undefined && (msgId === null || msgId === '')) {
    addIssue('pain001_no_msg_id', 'error', 'The group header has no MsgId. Banks reject a file without a message identification.');
  } else if (msgId !== null && msgId.length > 35) {
    addIssue('pain001_id_too_long', 'error', `MsgId is ${msgId.length} characters; the schema maximum is 35.`);
  }

  const headerNbOfTxs = groupHeader === undefined ? null : text(groupHeader, 'NbOfTxs');
  const headerCtrlSum = groupHeader === undefined ? null : text(groupHeader, 'CtrlSum');
  const creDtTm = groupHeader === undefined ? null : text(groupHeader, 'CreDtTm');
  if (groupHeader !== undefined && creDtTm === null) {
    addIssue('pain001_no_creation_datetime', 'warning', 'The group header has no CreDtTm (creation date time).');
  }

  // One PmtInf block is one batch with its own control figures; a file can hold
  // several, and each gets the same control-sum treatment.
  const paymentBlocks = blocks(source, 'PmtInf');
  const records = [];
  let transactionIndex = 0;

  for (let b = 0; b < paymentBlocks.length; b++) {
    const pmtInf = paymentBlocks[b];
    const pmtInfId = text(pmtInf, 'PmtInfId');
    const reqdExctnDt = text(pmtInf, 'ReqdExctnDt') ?? text(pmtInf, 'Dt');
    const pmtNbOfTxs = text(pmtInf, 'NbOfTxs');
    const pmtCtrlSum = text(pmtInf, 'CtrlSum');
    const label = pmtInfId ?? `batch_${b + 1}`;

    if (pmtInfId !== null && pmtInfId.length > 35) {
      addIssue('pain001_id_too_long', 'error', `PmtInfId ${JSON.stringify(pmtInfId)} is ${pmtInfId.length} characters; the schema maximum is 35.`);
    }

    const debtorName = text(blocks(pmtInf, 'Dbtr')[0] ?? '', 'Nm');
    const transactions = blocks(pmtInf, 'CdtTrfTxInf');
    if (transactions.length === 0) {
      addIssue('pain001_empty_batch', 'warning', `Batch ${label} contains no credit transfer instructions.`);
    }

    let batchCents = 0;
    for (const tx of transactions) {
      transactionIndex++;
      const endToEndId = text(tx, 'EndToEndId');
      const instdAmt = attributedAmount(tx, 'InstdAmt');
      const creditorName = text(blocks(tx, 'Cdtr')[0] ?? tx, 'Nm');
      const iban = text(blocks(tx, 'CdtrAcct')[0] ?? '', 'IBAN');
      const agentBlock = blocks(tx, 'CdtrAgt')[0] ?? '';
      const bic = text(agentBlock, 'BIC') ?? text(agentBlock, 'BICFI');
      const remittance = text(tx, 'Ustrd') ?? text(tx, 'RmtInf');
      const tag = endToEndId ?? `#${transactionIndex}`;

      if (iban === null) addIssue('pain001_no_iban', 'error', `Instruction ${tag} has no CdtrAcct/IBAN element.`);
      if (instdAmt === null) addIssue('pain001_no_amount', 'error', `Instruction ${tag} has no InstdAmt element.`);
      else if (instdAmt.currency === null) addIssue('pain001_no_currency', 'error', `Instruction ${tag} has an InstdAmt with no Ccy attribute.`);

      const cents = toCents(instdAmt === null ? null : instdAmt.amount);
      if (cents !== null) batchCents += cents;

      if (endToEndId === null) {
        addIssue('pain001_no_end_to_end_id', 'warning', `Instruction ${transactionIndex} has no EndToEndId, so the payment cannot be reconciled automatically.`);
      } else if (endToEndId.length > 35) {
        addIssue('pain001_id_too_long', 'error', `EndToEndId ${JSON.stringify(endToEndId)} is ${endToEndId.length} characters; the schema maximum is 35.`);
      }

      records.push({
        __line: transactionIndex,
        iban: iban ?? '',
        name: creditorName ?? '',
        amount: instdAmt === null ? '' : instdAmt.amount,
        currency: (instdAmt && instdAmt.currency) || 'EUR',
        bic: bic ?? '',
        reference: endToEndId ?? '',
        date: reqdExctnDt ?? '',
        country: '',
        vat: '',
        batch: label,
        debtor: debtorName ?? '',
        remittance: remittance ?? '',
      });
    }

    const declaredBatchCents = toCents(pmtCtrlSum);
    if (declaredBatchCents !== null && declaredBatchCents !== batchCents) {
      addIssue('pain001_batch_sum_mismatch', 'error', `Batch ${label} declares a control sum of ${(declaredBatchCents / 100).toFixed(2)} but its instructions add up to ${(batchCents / 100).toFixed(2)}.`);
    }
    if (pmtNbOfTxs !== null && Number(pmtNbOfTxs) !== transactions.length) {
      addIssue('pain001_batch_count_mismatch', 'error', `Batch ${label} declares ${pmtNbOfTxs} instruction(s) but contains ${transactions.length}.`);
    }
  }

  if (headerCtrlSum === null && groupHeader !== undefined) {
    addIssue('pain001_no_ctrl_sum', 'warning', 'The group header has no CtrlSum, so the file cannot be checked for a matching total.');
  }

  return {
    header: {
      msgId: msgId ?? null,
      creDtTm,
      nbOfTxs: headerNbOfTxs === null ? null : Number(headerNbOfTxs),
      ctrlSum: headerCtrlSum,
      ctrlSumCents: toCents(headerCtrlSum),
      batches: paymentBlocks.length,
    },
    records,
    issues,
    transactionCount: transactionIndex,
  };
}

/**
 * Parse and audit a pain.001 document in one step.
 *
 * The transactions go through exactly the same engine as a CSV upload, so an
 * instruction-level defect is grouped per defect class with its line numbers,
 * and a document-level defect fails the file. One severity model, one report.
 */
export function auditPain001(xml, options = {}) {
  const parsed = parsePain001(xml);
  const report = auditPaymentRun(parsed.records, {
    ...options,
    source: options.source ?? 'pain.001',
    declaredTotal: parsed.header.ctrlSumCents ?? undefined,
    declaredCount: parsed.header.nbOfTxs ?? undefined,
  });

  report.pain001 = { header: parsed.header, issues: parsed.issues };

  for (const issue of parsed.issues) {
    const existing = report.findings.find((f) => f.code === issue.code);
    if (existing) {
      existing.count++;
      continue;
    }
    report.findings.push({ code: issue.code, severity: issue.severity, count: 1, message: issue.message, lines: [], exampleFix: null });
  }

  report.findings.sort(
    (a, b) => ['error', 'warning', 'info'].indexOf(a.severity) - ['error', 'warning', 'info'].indexOf(b.severity) || b.count - a.count,
  );

  const countOf = (severity) => report.findings
    .filter((f) => f.severity === severity && f.code.startsWith('pain001_'))
    .reduce((n, f) => n + f.count, 0);

  report.summary.errors += countOf('error');
  report.summary.warnings += countOf('warning');
  report.summary.blocking = report.summary.errors > 0;
  report.summary.clean = report.summary.errors === 0 && report.summary.warnings === 0;

  return report;
}