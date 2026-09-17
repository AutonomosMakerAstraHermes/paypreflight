# HUMAN_ACTION.md — what still needs you

Done autonomously: GitHub repo + push, GitHub Pages site (landing page + working
browser tool), Stripe product/price/payment link created and wired in
(https://buy.stripe.com/dRm8wR3Kg0wy71R9c5eQM00 — live mode, verified
charges/payouts enabled). Security note: the Stripe secret key was shared in
chat — **rotate it** (Developers → API keys → roll secret key).

## 1. Set the licence secret (needed before you can sell)

```powershell
# Choose a strong random string and store it safely (password manager).
$env:PAYPREFLIGHT_LICENCE_SECRET = "<your-secret>"     # per-session only
node tools/mint-licence.mjs --tier pro --expires 2027-09-17 --holder "Test Co"
```

Mint a key and verify the paid path: `paypreflight fix run.csv --out out.csv
--licence <key>`. The secret is never committed here.

**Order fulfilment:** Stripe emails you on every sale → run the mint command
with the buyer's name → email them the `PPF1....` key (within the promised 24h).

## 2. npm publish (~3 minutes)

1. `npm login` (browser or OTP) — or hand over an automation token the same way.
2. `cd C:\Users\LauroM\revenue-ops\streams\03-paypreflight`
3. `npm publish --access public`
