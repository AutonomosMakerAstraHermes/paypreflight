/**
 * Build the browser tool: site/index.html plus the lib modules it imports.
 *
 * Everything the page does runs in the visitor's browser. There is no server,
 * no upload, no analytics on the file contents - the privacy promise of the
 * CLI (the creditor list never leaves the machine) has to hold here too, and
 * it is easiest to keep by having no network code at all, like the CLI.
 *
 * The build copies lib/ and data/ into site/ so the folder is deployable on
 * its own (GitHub Pages, any static host). The page imports ./lib/index.js
 * and ./lib/fix.js as ES modules; every module they reach is browser-safe -
 * only lib/licence.js uses node:crypto and the page never imports it.
 *
 * Run:  node tools/build-site.mjs
 */

import { mkdirSync, rmSync, copyFileSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

if (existsSync(SITE)) rmSync(SITE, { recursive: true });
mkdirSync(join(SITE, 'lib'), { recursive: true });
mkdirSync(join(SITE, 'data'), { recursive: true });

for (const file of readdirSync(join(ROOT, 'lib'))) {
  if (file === 'licence.js') continue; // Node-only; the page has no licence logic.
  copyFileSync(join(ROOT, 'lib', file), join(SITE, 'lib', file));
}
for (const file of readdirSync(join(ROOT, 'data'))) {
  copyFileSync(join(ROOT, 'data', file), join(SITE, 'data', file));
}

const html = readFileSync(join(ROOT, 'tools', 'site-template.html'), 'utf8');
writeFileSync(join(SITE, 'index.html'), html);
console.log(`site built: ${SITE} (${readdirSync(join(SITE, 'lib')).length} lib modules)`);
