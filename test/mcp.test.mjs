/**
 * MCP server tests.
 *
 * Two layers, because they fail differently:
 *
 *  1. handleMessage() in-process, which pins the protocol semantics (what is a
 *     notification, what is an error, what a tool result looks like).
 *  2. A real child process speaking newline-delimited JSON-RPC over stdio,
 *     which is the only way to catch the failure that matters in production:
 *     a stray write to stdout that corrupts the stream. An in-process test
 *     cannot see that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleMessage, callTool } from '../bin/mcp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(root, 'bin', 'mcp.mjs');

const request = (id, method, params) => handleMessage({ jsonrpc: '2.0', id, method, params });

test('initialize reports the server identity and the client protocol version', async () => {
  const response = await request(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.equal(response.result.serverInfo.name, 'paypreflight');
  assert.ok(response.result.capabilities.tools);
});

test('initialize falls back to a known protocol version when the client omits one', async () => {
  const response = await request(1, 'initialize', {});
  assert.equal(typeof response.result.protocolVersion, 'string');
  assert.ok(response.result.protocolVersion.length > 0);
});

test('a notification produces no response at all', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
});

test('tools/list advertises four tools with schemas', async () => {
  const response = await request(2, 'tools/list');
  const names = response.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['audit_payment_file', 'check_iban', 'check_vat_structure', 'explain_checks']);
  for (const tool of response.result.tools) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description for an agent to choose it`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('an unknown method is a protocol error, not a crash', async () => {
  const response = await request(3, 'tools/teleport');
  assert.equal(response.error.code, -32601);
});

test('an unknown tool is an error inside the result, per the protocol', async () => {
  const response = await request(4, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(response.error.code, -32603);
});

test('check_iban returns the repair for a wrong check digit pair', async () => {
  const result = await callTool('check_iban', { iban: 'GB28WEST12345698765432' });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.valid, false);
  assert.equal(payload.suggestedIban, 'GB82WEST12345698765432');
  assert.equal(payload.suggestedFormatted, 'GB82 WEST 1234 5698 7654 32');
});

test('check_iban reports SEPA reachability alongside validity', async () => {
  const inside = JSON.parse((await callTool('check_iban', { iban: 'DE89370400440532013000' })).content[0].text);
  assert.equal(inside.valid, true);
  assert.equal(inside.sepaScope, true);
  assert.equal(inside.bankIdentifier, '37040044');

  const outside = JSON.parse((await callTool('check_iban', { iban: 'TR330006100519786457841326' })).content[0].text);
  assert.equal(outside.valid, true);
  assert.equal(outside.sepaScope, false);
  assert.match(outside.note, /outside the SEPA/);
});

test('check_vat_structure states that registration was not checked', async () => {
  const payload = JSON.parse((await callTool('check_vat_structure', { vat: 'DE811907980' })).content[0].text);
  assert.equal(payload.structurallyValid, true);
  assert.equal(payload.registrationChecked, false);
  assert.match(payload.limitation, /does not confirm/);
});

test('audit_payment_file audits content the agent supplies', async () => {
  const content = readFileSync(join(root, 'fixtures', 'suppliers-messy.csv'), 'utf8');
  const payload = JSON.parse((await callTool('audit_payment_file', { content })).content[0].text);
  assert.equal(payload.blocking, true);
  assert.equal(payload.summary.rows, 10);
  assert.ok(payload.findings.some((f) => f.code === 'iban_invalid'));
  assert.ok(payload.findings.some((f) => f.code === 'iban_outside_sepa'));
});

test('audit_payment_file audits a pain.001 control sum mismatch', async () => {
  const content = readFileSync(join(root, 'fixtures', 'pain001-mismatch.xml'), 'utf8');
  const payload = JSON.parse((await callTool('audit_payment_file', { content })).content[0].text);
  assert.ok(payload.findings.some((f) => f.code === 'declared_total_mismatch'));
  assert.equal(payload.pain001.header.ctrlSumCents, 50000);
});

test('a tool given nothing usable reports an error rather than throwing', async () => {
  const result = await callTool('audit_payment_file', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /needs either content or path/);
});

test('explain_checks is explicit about the limits', async () => {
  const payload = JSON.parse((await callTool('explain_checks', {})).content[0].text);
  assert.ok(payload.checks.length >= 8);
  assert.ok(payload.doesNotCheck.some((line) => /VIES/.test(line)));
  assert.equal(payload.coverage.ibanCountryCodes, 116);
  assert.equal(payload.coverage.vatAreas, 28);
});
/** Speak the protocol to a real child process and collect what it writes. */
function talkToServer(messages, timeoutMs = 20000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`server did not answer in ${timeoutMs}ms. stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', () => {
      clearTimeout(timer);
      resolvePromise({ out, err });
    });

    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

test('over stdio, every stdout line is valid JSON-RPC and nothing else', async () => {
  const { out } = await talkToServer([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_iban', arguments: { iban: 'GB82WEST12345698765432' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'audit_payment_file', arguments: { content: 'iban,name\nGB28WEST12345698765432,Ada\n' } } },
  ]);

  const lines = out.split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 4, `expected four responses, got ${lines.length}: ${out}`);

  for (const line of lines) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    assert.ok(message.id >= 1);
    assert.ok('result' in message || 'error' in message);
  }

  const payload = JSON.parse(JSON.parse(lines[3]).result.content[0].text);
  assert.equal(payload.blocking, true);
});

test('stderr carries diagnostics without polluting the protocol stream', async () => {
  const { err } = await talkToServer([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.match(err, /listening on stdio/);
});

test('an unknown method over stdio is answered and the session survives', async () => {
  const { out } = await talkToServer([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/teleport' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ]);

  const lines = out.split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[1]).error.code, -32601);
  assert.deepEqual(JSON.parse(lines[2]).result, {});
});