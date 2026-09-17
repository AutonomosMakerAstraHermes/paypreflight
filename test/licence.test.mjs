import test from 'node:test';
import assert from 'node:assert/strict';
import { issueLicence, verifyLicence, resolveLicence, TIER_LIMITS } from '../lib/licence.js';

const SECRET = 'unit-test-secret';

test('a minted pro key verifies and grants pro limits', () => {
  const { key } = issueLicence(SECRET, { tier: 'pro', expires: '2099-01-01', holder: 'ACME GmbH', seats: 5 });
  const result = verifyLicence(SECRET, key);
  assert.equal(result.valid, true);
  assert.equal(result.tier, 'pro');
  assert.equal(result.seats, 5);
  assert.equal(result.holder, 'ACME GmbH');
  assert.equal(result.limits.writeFixes, true);
  assert.equal(result.limits.maxRows, Infinity);
});

test('team tier verifies; free tier cannot be minted', () => {
  const { key } = issueLicence(SECRET, { tier: 'team', expires: '2099-01-01' });
  assert.equal(verifyLicence(SECRET, key).tier, 'team');
  assert.throws(() => issueLicence(SECRET, { tier: 'free', expires: '2099-01-01' }));
  assert.throws(() => issueLicence(SECRET, { tier: 'gold', expires: '2099-01-01' }));
});

test('a missing expiry is refused at mint time, not trusted later', () => {
  assert.throws(() => issueLicence(SECRET, { tier: 'pro' }));
  assert.throws(() => issueLicence(SECRET, { tier: 'pro', expires: 'next tuesday' }));
});

test('a key signed with a different secret is rejected', () => {
  const { key } = issueLicence(SECRET, { tier: 'pro', expires: '2099-01-01' });
  const result = verifyLicence('other-secret', key);
  assert.equal(result.valid, false);
  assert.equal(result.tier, 'free');
});

test('a tampered payload is rejected', () => {
  const { key } = issueLicence(SECRET, { tier: 'pro', expires: '2099-01-01' });
  const [, payload, signature] = key.split('.');
  const forged = Buffer.from(JSON.stringify({ t: 'pro', e: '2099-01-01', s: 999 })).toString('base64url');
  assert.equal(verifyLicence(SECRET, `PPF1.${forged}.${signature}`).valid, false);
  // Same payload but a truncated signature.
  assert.equal(verifyLicence(SECRET, `PPF1.${payload}.${signature.slice(0, 8)}`).valid, false);
});

test('an expired licence falls back to the free tier with an explanation', () => {
  const { key } = issueLicence(SECRET, { tier: 'pro', expires: '2020-01-01' });
  const result = verifyLicence(SECRET, key, new Date('2020-06-01T00:00:00Z'));
  assert.equal(result.valid, false);
  assert.match(result.reason, /expired on 2020-01-01/);
  assert.equal(result.limits, TIER_LIMITS.free);
});

test('garbage input never throws, just denies', () => {
  for (const junk of ['', '   ', 'hello', 'PPF1.abc', 'PPF1.!!!.???', null, undefined, 42]) {
    const result = verifyLicence(SECRET, junk);
    assert.equal(result.valid, false);
    assert.equal(result.tier, 'free');
  }
});

test('resolveLicence reads the key and secret from the environment', () => {
  const { key } = issueLicence(SECRET, { tier: 'pro', expires: '2099-01-01' });
  const env = { ...process.env, PAYPREFLIGHT_LICENCE: key, PAYPREFLIGHT_LICENCE_SECRET: SECRET };
  const saved = { k: process.env.PAYPREFLIGHT_LICENCE, s: process.env.PAYPREFLIGHT_LICENCE_SECRET };
  Object.assign(process.env, env);
  try {
    assert.equal(resolveLicence(null, null).valid, true);
    assert.equal(resolveLicence(SECRET, key).valid, true);
    // A key with no secret cannot be verified and must not be trusted.
    delete process.env.PAYPREFLIGHT_LICENCE_SECRET;
    const unresolved = resolveLicence(null, key);
    assert.equal(unresolved.valid, false);
    assert.match(unresolved.reason, /SECRET is not set/);
  } finally {
    delete process.env.PAYPREFLIGHT_LICENCE;
    delete process.env.PAYPREFLIGHT_LICENCE_SECRET;
    if (saved.k !== undefined) process.env.PAYPREFLIGHT_LICENCE = saved.k;
    if (saved.s !== undefined) process.env.PAYPREFLIGHT_LICENCE_SECRET = saved.s;
  }
});
