import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'paypreflight.mjs');
const MINT = join(ROOT, 'tools', 'mint-licence.mjs');
const SECRET = 'cli-test-secret';
const ENV = { ...process.env, PAYPREFLIGHT_LICENCE_SECRET: SECRET };
const CLEAN_CSV = 'Iban;Naam;Bedrag;Valuta\nNL91ABNA0417164300;Klanten B.V.;99.95;EUR\n';

function mint(flags = []) {
  const result = spawnSync('node', [MINT, ...flags], { encoding: 'utf8', env: ENV });
  return { ...result, key: result.stdout.split('\n')[0].trim() };
}

test('usage: bare command prints help with exit 0; unknown command exits 2', () => {
  assert.equal(spawnSync('node', [CLI], { encoding: 'utf8' }).status, 0);
  const unknown = spawnSync('node', [CLI, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command/);
  assert.match(unknown.stderr, /Usage/);
});

test('iban command: valid exits 0, broken exits 1 with a repair suggestion', () => {
  assert.equal(spawnSync('node', [CLI, 'iban', 'GB82WEST12345698765432'], { encoding: 'utf8' }).status, 0);
  const bad = spawnSync('node', [CLI, 'iban', 'GB82WEST12345698765433'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /GB55WEST12345698765433/, 'the repair must be printed');
});

test('check: clean file exits 0 quietly, messy file exits 1, --json is valid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppf-cli-'));
  const clean = join(dir, 'clean.csv');
  writeFileSync(clean, CLEAN_CSV);
  assert.equal(spawnSync('node', [CLI, 'check', clean, '--quiet'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('node', [CLI, 'check', join(ROOT, 'fixtures', 'suppliers-messy.csv')], { encoding: 'utf8' }).status, 1);

  const json = JSON.parse(spawnSync('node', [CLI, 'check', clean, '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(json.summary.clean, true);

  // A hard cap is a refusal, not a silent truncation: exit 2 either way.
  const capped = spawnSync('node', [CLI, 'check', clean, '--max-rows', '0'], { encoding: 'utf8' });
  assert.equal(capped.status, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('check accepts JSON records and pain.001 through the same front door', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppf-cli-'));
  const jsonPath = join(dir, 'run.json');
  writeFileSync(jsonPath, JSON.stringify([
    { iban: 'NL91ABNA0417164300', name: 'Klanten B.V.', amount: '99.95', currency: 'EUR' },
  ]));
  assert.equal(spawnSync('node', [CLI, 'check', jsonPath, '--quiet'], { encoding: 'utf8' }).status, 0);

  const painPath = join(dir, 'pain.xml');
  writeFileSync(painPath, readFileSync(join(ROOT, 'fixtures', 'pain001-mismatch.xml'), 'utf8'));
  const pain = spawnSync('node', [CLI, 'check', painPath], { encoding: 'utf8' });
  assert.equal(pain.status, 1, 'the mismatch fixture must fail the control-sum check');
  rmSync(dir, { recursive: true, force: true });
});

test('licence command reports the tier in effect and why', () => {
  const free = spawnSync('node', [CLI, 'licence'], { encoding: 'utf8', env: ENV });
  assert.match(free.stdout, /tier\s+free/);
  const { key } = mint(['--tier', 'pro', '--expires', '2099-01-01', '--holder', 'CI Test']);
  const pro = spawnSync('node', [CLI, 'licence', '--licence', key], { encoding: 'utf8', env: ENV });
  assert.match(pro.stdout, /tier\s+pro/);
  assert.match(pro.stdout, /CI Test/);
});

test('mint-licence: refuses without a secret, refuses without an expiry, works end to end', () => {
  const noSecret = spawnSync('node', [MINT, '--expires', '2099-01-01'], { encoding: 'utf8' });
  assert.equal(noSecret.status, 2);
  assert.match(noSecret.stderr, /PAYPREFLIGHT_LICENCE_SECRET/);

  const noExpiry = spawnSync('node', [MINT], { encoding: 'utf8', env: ENV });
  assert.equal(noExpiry.status, 2);
  assert.match(noExpiry.stderr, /--expires/);

  const ok = mint(['--tier', 'pro', '--expires', '2099-01-01', '--holder', 'Mint Test']);
  assert.equal(ok.status, 0);
  assert.match(ok.key, /^PPF1\./);
  assert.match(ok.stderr, /tier=pro/);
  // The minted key actually unlocks the paid command.
  const dir = mkdtempSync(join(tmpdir(), 'ppf-mint-'));
  const src = join(dir, 'run.csv');
  writeFileSync(src, 'Iban;Naam;Bedrag;Valuta\nGB82WEST12345698765433;ACME Ltd;1250,00;EUR\n');
  const fix = spawnSync('node', [CLI, 'fix', src, '--out', join(dir, 'fixed.csv'), '--licence', ok.key],
    { encoding: 'utf8', env: ENV });
  assert.equal(fix.status, 0, `fix failed: ${fix.stdout}${fix.stderr}`);
  assert.match(readFileSync(join(dir, 'fixed.csv'), 'utf8'), /GB55WEST12345698765433/);
  rmSync(dir, { recursive: true, force: true });
});
