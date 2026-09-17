# HUMAN_ACTION.md — publishing needs you

Everything buildable, testable and preparable has been done autonomously
(103/103 tests pass, `npm pack --dry-run` is clean). What remains requires
credentials only you hold. Each step is small and independent.

## 1. Create the GitHub repository (~2 minutes)

1. Create repo `paypreflight` under your account (public, empty, no README —
   one exists here).
2. Then, in `C:\Users\LauroM\revenue-ops\streams\03-paypreflight`:

```bash
git remote add origin https://github.com/<your-account>/paypreflight.git
git push -u origin main
```

3. Optional distribution boost: Settings → Pages → deploy from a branch or a
   GitHub Action, serving the `site/` folder.

## 2. Publish to npm (~3 minutes)

1. `npm login` (browser or OTP).
2. `cd C:\Users\LauroM\revenue-ops\streams\03-paypreflight`
3. `npm pack` and sanity-check the tarball, then `npm publish --access public`.

## 3. Set the licence secret (needed before you can sell)

```powershell
# Choose a strong secret and store it safely (password manager).
$env:PAYPREFLIGHT_LICENCE_SECRET = "<your-secret>"     # per-session only
node tools/mint-licence.mjs --tier pro --expires 2027-09-17 --holder "Test Co"
```

Mint a key and verify the paid path: `paypreflight fix run.csv --out out.csv
--licence <key>`. Keep the secret in your password manager / CI secret store;
it is never committed here.

## 4. Optionally verify checkout

A payment link (Lemon Squeezy / Gumroad / Stripe Payment Link) can be added to
the README and site footer in minutes. Do not create fake sales pages before
this exists — the product is honest about what works and what does not.
