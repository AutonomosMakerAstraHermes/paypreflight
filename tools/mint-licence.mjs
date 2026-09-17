#!/usr/bin/env node
/**
 * Licence issuer - the seller-side tool.
 *
 * The buyer never sees this file in spirit: what they receive is a PPF1 key
 * and the promise that PAYPREFLIGHT_LICENCE_SECRET stays with the issuer.
 * Minting needs the secret and nothing else, which is why the tool refuses to
 * read it from command-line arguments - a secret in argv lands in shell
 * history and process listings. It comes from the environment or a prompt.
 *
 * Usage:
 *   PAYPREFLIGHT_LICENCE_SECRET=... node tools/mint-licence.mjs \
 *     --tier pro --expires 2027-09-17 --seats 5 --holder "ACME GmbH"
 *
 * Verify what you minted with:
 *   PAYPREFLIGHT_LICENCE_SECRET=... paypreflight licence --licence <key>
 */

import { stdin } from 'node:process';
import { issueLicence } from '../lib/licence.js';

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error(`Unexpected argument ${args[i]}.`);
    const key = args[i].slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value.`);
    out[key] = value;
    i++;
  }
  return out;
}

function readSecretFromStdin() {
  return new Promise((resolve) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', () => resolve(data.trim()));
  });
}

const args = parseArgs(process.argv.slice(2));
const secret = process.env.PAYPREFLIGHT_LICENCE_SECRET
  ?? ((stdin.isTTY && (await readSecretFromStdin())) || '');

if (!secret) {
  console.error('Set PAYPREFLIGHT_LICENCE_SECRET (or pipe it via stdin). Never pass a secret as an argument.');
  process.exit(2);
}

if (!args.expires) {
  console.error('--expires YYYY-MM-DD is required. Licences without an expiry are how unlimited free keys happen by accident.');
  process.exit(2);
}

const { key, payload } = issueLicence(secret, {
  tier: args.tier ?? 'pro',
  expires: args.expires,
  seats: args.seats ? Number(args.seats) : undefined,
  holder: args.holder,
});

console.log(key);
console.error(`tier=${payload.t} seats=${payload.s} holder=${payload.h || '-'} expires=${payload.e}`);
