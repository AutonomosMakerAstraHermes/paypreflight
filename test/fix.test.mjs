import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'paypreflight.mjs');
const SECRET = 'fix-test-secret';

function mintPro() {
  const script = `import('./lib/licence.js').then(m => { console.log(m.issueLicence(${JSON.stringify(SECRET)}, { tier: 'pro', expires: '2099-01-01', holder: 'test' }).key); })`;
  const { status, stdout, stderr } = spawnSync('node', ['-e', script], { cwd: join(HERE, '..'), encoding: 'utf8' });
  assert.equal(status, 0, `mint failed: ${stdout}${stderr}`);
  return stdout.trim();
}

test('fix with a Pro licence writes rows that actually carry the data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppf-fix-'));
  const src = join(dir, 'run.csv');
  const dst = join(dir, 'fixed.csv');
  // Semicolon-delimited, European amounts, a bad check-digit IBAN and a bad
  // character: the realistic export this command exists for.
  const csv = [
    'Iban;Naam;Bedrag;Valuta',
    'GB82WEST12345698765433;Handel & Zonen BV;1250,00;EUR',
    'NL18RABO0123456789;Klanten B.V.;99,95;EUR',
  ].join('\n');
  writeFileSync(src, csv);

  const pro = mintPro();
  const result = spawnSync('node', [CLI, 'fix', src, '--out', dst, '--licence', pro], {
    encoding: 'utf8',
    env: { ...process.env, PAYPREFLIGHT_LICENCE_SECRET: SECRET },
  });

  assert.equal(result.status, 0, `fix failed: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Wrote 2 corrected row/);

  const written = readFileSync(dst, 'utf8');
  const lines = written.trim().split(/\r?\n/);
  assert.equal(lines[0], 'Iban;Naam;Bedrag;Valuta', 'original headers must be preserved');
  // The written row must contain the repaired IBAN and canonical amount -
  // this is the regression guard for the empty-cells bug.
  assert.match(lines[1], /GB55WEST12345698765433;Handel Zonen BV;1250\.00;EUR/);
  assert.match(lines[2], /NL44RABO0123456789;Klanten B\.V\.;99\.95;EUR/);

  // The corrected file must re-audit clean.
  const recheck = spawnSync('node', [CLI, 'check', dst, '--quiet'], { encoding: 'utf8' });
  assert.equal(recheck.status, 0, `recheck failed: ${recheck.stdout}${recheck.stderr}`);

  rmSync(dir, { recursive: true, force: true });
});

test('the free tier gets the diff but never the corrected records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppf-free-'));
  const src = join(dir, 'run.csv');
  writeFileSync(src, 'Iban;Naam;Bedrag\nGB82WEST12345698765433;ACME Ltd;1250,00\n');

  const noFile = spawnSync('node', [CLI, 'fix', src, '--out', join(dir, 'x.csv')], { encoding: 'utf8' });
  assert.equal(noFile.status, 3, 'free fix --out <file> must exit 3');
  assert.match(noFile.stdout, /needs a Pro licence/);

  // stdout must not become a licence bypass either: no serialized CSV records.
  const noStdout = spawnSync('node', [CLI, 'fix', src, '--out', '-'], { encoding: 'utf8' });
  assert.equal(noStdout.status, 3, 'free fix --out - must exit 3');
  assert.doesNotMatch(noStdout.stdout, /^Iban;Naam;Bedrag$/m, 'free --out - must not print the CSV');

  const noJson = spawnSync('node', [CLI, 'fix', src, '--json'], { encoding: 'utf8' });
  assert.equal(noJson.status, 3, 'free fix --json must exit 3');
  const parsed = JSON.parse(noJson.stdout);
  assert.equal(parsed.records, undefined, 'free --json must not include corrected records');
  assert.ok(parsed.changes.length > 0, 'free --json still ships the change log');

  rmSync(dir, { recursive: true, force: true });
});
