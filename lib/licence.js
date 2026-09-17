/**
 * Offline licence keys.
 *
 * Design constraint that shapes everything here: this tool's promise is that a
 * creditor file never leaves the machine. A licence check that phoned home
 * would break that promise on every run, so a licence has to be verifiable
 * offline, by a program that ships no secret.
 *
 * The pattern is the same one stream 01 (Numera) uses for API keys, for the
 * same reason: the key carries its own entitlement. The payload states the tier
 * and the expiry, and an HMAC over that payload proves the issuer produced it.
 * Verification only needs the shared secret, which lives on the machine running
 * the check (a company licence) or in the buyer's CI secret store.
 *
 * Honest limitations, stated because they matter:
 *   - Anyone holding the secret can mint keys. That is inherent to offline
 *     verification, and it is why a leaked secret means rotating it.
 *   - A key cannot be revoked before it expires.
 *   - A determined user can patch the check out. The licence is a fair-use
 *     mechanism for businesses that want to pay for a tool they rely on, not a
 *     copy protection scheme, and pretending otherwise would be dishonest.
 *
 * Format:  PPF1.<base64url(payload)>.<base64url(hmac)>
 * Payload: { t: tier, e: 'YYYY-MM-DD' expiry, s: seats, h: holder, i: issue date }
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const TIERS = ['free', 'pro', 'team'];

/** Tier limits. The free cap is deliberately low enough to pinch in real use. */
export const TIER_LIMITS = Object.freeze({
  free: { maxRows: 5000, writeFixes: false, label: 'Free' },
  pro: { maxRows: Infinity, writeFixes: true, label: 'Pro' },
  team: { maxRows: Infinity, writeFixes: true, label: 'Team' },
});

const base64url = (value) => Buffer.from(value, 'utf8').toString('base64url');
const fromBase64url = (value) => Buffer.from(value, 'base64url').toString('utf8');

function sign(secret, payloadPart) {
  return createHmac('sha256', secret).update(payloadPart).digest();
}

/**
 * Mint a licence key. Only the issuer runs this; it needs the secret.
 * Returns { key, payload }.
 */
export function issueLicence(secret, options = {}) {
  const tier = options.tier ?? 'pro';
  if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}". Known tiers: ${TIERS.join(', ')}.`);
  if (tier === 'free') throw new Error('The free tier needs no key. Issue pro or team.');

  const issued = options.issued ?? new Date().toISOString().slice(0, 10);
  const expiry = options.expires;
  if (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    throw new Error('expires must be a YYYY-MM-DD date.');
  }

  const payload = {
    t: tier,
    e: expiry,
    s: Number.isInteger(options.seats) ? options.seats : 1,
    h: String(options.holder ?? '').slice(0, 60),
    i: issued,
  };

  const payloadPart = base64url(JSON.stringify(payload));
  const signaturePart = sign(secret, payloadPart).toString('base64url');
  return { key: `PPF1.${payloadPart}.${signaturePart}`, payload };
}

/**
 * Verify a licence key.
 *
 * Never throws on malformed input: a caller hands in whatever a user typed, and
 * the answer to "is this a licence" is a result object, not an exception.
 * Returns { valid, tier, seats, holder, expires, reason, limits }.
 */
export function verifyLicence(secret, key, today = new Date()) {
  const denied = (reason) => ({
    valid: false,
    tier: 'free',
    reason,
    limits: TIER_LIMITS.free,
  });

  const text = String(key ?? '').trim();
  if (text === '') return denied('No licence key supplied, so the free tier applies.');

  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== 'PPF1') return denied('That is not a paypreflight licence key: expected PPF1.<payload>.<signature>.');

  const [, payloadPart, signaturePart] = parts;

  let expected;
  let provided;
  try {
    expected = sign(secret, payloadPart);
    provided = Buffer.from(signaturePart, 'base64url');
  } catch {
    return denied('The licence key could not be decoded.');
  }

  // Length must match before timingSafeEqual, which throws on unequal lengths.
  if (provided.length !== expected.length) return denied('The licence signature is the wrong length.');
  if (!timingSafeEqual(expected, provided)) return denied('The licence signature does not match. Check that the key was copied whole.');

  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadPart));
  } catch {
    return denied('The licence payload is not readable.');
  }

  if (!TIERS.includes(payload.t) || payload.t === 'free') return denied('The licence payload names no paid tier.');

  if (payload.e !== undefined) {
    const expires = Date.parse(`${payload.e}T23:59:59Z`);
    if (Number.isNaN(expires)) return denied('The licence expiry date is unreadable.');
    if (today.getTime() > expires) {
      return { valid: false, tier: 'free', expires: payload.e, reason: `The licence expired on ${payload.e}.`, limits: TIER_LIMITS.free };
    }
  }

  return {
    valid: true,
    tier: payload.t,
    seats: payload.s ?? 1,
    holder: payload.h ?? '',
    issued: payload.i ?? null,
    expires: payload.e ?? null,
    reason: `Valid ${TIER_LIMITS[payload.t].label} licence${payload.h ? ` for ${payload.h}` : ''}${payload.e ? `, expiring ${payload.e}` : ''}.`,
    limits: TIER_LIMITS[payload.t],
  };
}

/** Resolve the effective licence from an explicit key or the environment. */
export function resolveLicence(secret, explicitKey = null) {
  const key = explicitKey ?? process.env.PAYPREFLIGHT_LICENCE ?? '';
  const secretValue = secret ?? process.env.PAYPREFLIGHT_LICENCE_SECRET ?? '';
  if (key === '') return verifyLicence('', '');
  if (secretValue === '') {
    return {
      valid: false,
      tier: 'free',
      reason: 'A licence key was supplied but PAYPREFLIGHT_LICENCE_SECRET is not set, so it cannot be verified.',
      limits: TIER_LIMITS.free,
    };
  }
  return verifyLicence(secretValue, key);
}