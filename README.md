# paypreflight

**Pre-flight checks for an EU payment run.** Audit a CSV, JSON or ISO 20022
pain.001 batch *before* it goes to the bank — while a wrong IBAN is still a
spreadsheet problem and not a payment recall. IBAN checksums (116 countries),
SEPA character set and amount rules, VAT number structure (28 areas), duplicate
end-to-end references, declared-versus-actual control sums.

Runs entirely on your machine. **No account, no upload, no telemetry — the
package has no network code at all.** The file being checked is a creditor
list; being able to check it without sending a copy to a third party is the
point.

```bash
npm i -g paypreflight        # once published; until then: git clone + npm link
paypreflight check suppliers.csv
paypreflight fix suppliers.csv --out suppliers-fixed.csv --licence PPF1.…
paypreflight iban GB82WEST12345698765433
paypreflight vat DE136695976
```

## What it checks

| Area | Examples |
| --- | --- |
| IBAN | ISO 7064 MOD 97-10 checksum, country length and structure (116 registry countries), bank-code extraction, repair suggestion when only the check digits are wrong |
| SEPA | EPC character-set offences (`&`, quotes, control chars), amount notation (`1250,00` → `1250.00`), zero/negative/oversized amounts, EUR rule for euro credit transfers, optional BIC country match, SEPA-scope hints (incl. Crown Dependencies) |
| Run level | duplicate end-to-end references, declared control sum vs. computed sum, number of transactions vs. header |
| VAT | structure per country (28 areas) — offline only; live registration is VIES's job and the tool says so |
| pain.001 | the same rules against XML batches, plus GrpHdr control-sum verification |

Exit codes are the CI contract: `0` clean, `1` findings at/above `--fail-on`,
`2` usage/limit error (a row cap is a refusal, never a silent truncation), `3`
a paid feature without a licence.

## The `fix` command (Pro)

`check` is free and stays free. `fix` goes further: it rewrites the run —
repaired check digits (re-verified before writing), canonical amounts, names
stripped to the EPC character set — and emits a change log alongside the
corrected file. Anything a machine should not guess (missing IBAN, zero amount)
is left for a person and listed.

```bash
paypreflight fix run.csv --out run-fixed.csv            # free: full diff, exit 3
paypreflight fix run.csv --out run-fixed.csv --licence PPF1.xxx.yyy
```

## Licensing (offline)

A licence is verified offline with an HMAC over its payload: the key carries
its entitlement, so the tool never phones home. Free tier: 5,000 rows, full
diagnostics. Pro: unlimited rows + corrected-file output. The secret lives only
with the issuer:

```bash
PAYPREFLIGHT_LICENCE_SECRET=… node tools/mint-licence.mjs \
  --tier pro --expires 2027-09-17 --seats 5 --holder "ACME GmbH"
```

Honest limits, stated in `lib/licence.js`: keys can't be revoked before expiry,
and a determined user can patch the check out — this is a fair-use mechanism
for businesses that want to pay for what they rely on, not copy protection.

## MCP server

The same engine speaks MCP over stdio, so AI agents (Claude Desktop, Cursor,
Cline…) can run the checks:

```bash
paypreflight mcp   # prints the config snippet
```

## Browser tool

`node tools/build-site.mjs` builds `site/` — a fully client-side page that
audits and fixes files in the browser. Same privacy promise: no upload path
exists. Deploy `site/` to any static host.

## Development

```bash
npm test            # node --test, zero dependencies
npm run lint:fixtures
npm run port        # regenerate data/ from the registry sources
npm run site
```

Engine MIT-licensed. Data files derived from the SWIFT IBAN Registry (ISO
13616) and EPC/EC documentation.
