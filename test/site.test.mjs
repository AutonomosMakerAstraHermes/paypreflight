import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

test('the site builds and is self-contained', () => {
  execFileSync('node', ['tools/build-site.mjs'], { cwd: ROOT });
  assert.equal(existsSync(join(ROOT, 'site', 'index.html')), true);
  assert.equal(existsSync(join(ROOT, 'site', 'lib', 'index.js')), true);
  assert.equal(existsSync(join(ROOT, 'site', 'data', 'iban-registry.js')), true);
  // licence.js is the one Node-only module and must not ship to the browser.
  assert.equal(existsSync(join(ROOT, 'site', 'lib', 'licence.js')), false);
});

test('every module the page can reach is browser-safe (no node: imports)', () => {
  // Walk the actual import graph starting from what index.html imports, so a
  // future `import ... from 'node:x'` anywhere in the engine fails here.
  const seen = new Set();
  const queue = ['lib/index.js', 'lib/fix.js'];
  const offenders = [];
  while (queue.length > 0) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = readFileSync(join(ROOT, 'site', rel), 'utf8');
    if (/from ['"]node:/.test(source) || /require\(['"]node:/.test(source)) offenders.push(rel);
    for (const match of source.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) {
      queue.push(join('lib', match[1].replaceAll('../', '').replaceAll('./', '')));
    }
  }
  assert.deepEqual(offenders, [], `Node-only modules reached the browser: ${offenders.join(', ')}`);
});

test('the page wires its inputs to the engine', () => {
  const html = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
  assert.match(html, /type="module"/);
  assert.match(html, /from '\.\/lib\/index\.js'/);
  for (const id of ['file', 'drop', 'paste', 'go', 'result', 'verdict', 'report', 'fixDetails', 'download']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
});
