# HUMAN_ACTION.md — what still needs you

Done autonomously: GitHub repo + push, GitHub Pages site (landing page + working
browser tool), Stripe product/price/payment link live and wired in
(https://buy.stripe.com/dRm8wR3Kg0wy71R9c5eQM00), **npm published**
(paypreflight@0.1.0 — `npm i -g paypreflight` / `npx paypreflight` works).

⚠️ Rotate both secrets, they were shared in chat:
- Stripe: Dashboard → Developers → API keys → roll secret key
- npm: npmjs.com → Access Tokens → delete the token

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

## 2. Optional next steps

- Set support email / branding in Stripe so buyers see a professional checkout.
- List the MCP server in MCP directories (needs the npm package — now done).
- Watch https://www.npmjs.com/package/paypreflight for install counts.
