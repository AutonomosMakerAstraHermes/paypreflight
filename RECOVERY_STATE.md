# RECOVERY_STATE.md

## Recovered objective

Continue the autonomous Revenue Operator mission from Cline session
`session_1789610783879_oef84` (workspace was wrongly `C:\Users\LauroM`; restore
crashed with `stderr maxBuffer length exceeded`, so state was recovered from
`.cline/data/sessions/` directly). Active build: **paypreflight** — an offline
CLI + MCP server that audits EU payment runs (CSV/JSON/pain.001) for IBAN,
SEPA charset, VAT-structure and cross-row defects, freemium: diagnosis free,
corrected-file writing behind an offline HMAC licence (Pro).

## Project root

`C:\Users\LauroM\revenue-ops\streams\03-paypreflight`
(NOT the home directory; prior streams live in `C:\Users\LauroM\revenue-ops\streams\`.)

## Completed work (recovered + verified)

- 116-country IBAN registry + 28 VAT format areas ported and fixture-verified.
- Core libs: iban.js, sepa.js, vat.js, csv.js, pain001.js, audit.js (one engine,
  CSV/JSON/pain.001 inputs, cross-row duplicate + declared-totals checks).
- CLI: check / iban / vat / mcp / version; exit codes 0/1/2/3 documented.
- MCP server (bin/mcp.mjs) with stdio integration tests.
- 84 tests passing before the fix engine.
- fix.js (fix engine) + licence.js (offline PPF1.<payload>.<hmac> keys) written;
  fix engine smoke-tested: 13 changes, 2 defects correctly left to a human.
- commandFix / commandLicence written into bin/paypreflight.mjs.

## Current state

Complete and verified (86/86 tests pass). Finished by this recovery session:
- Wired `fix` and `licence` into the command switch in `main()` (was missing —
  the exact point the old session died).
- Fixed `resolveLicence()` argument order in commandFix/commandLicence.
- Fixed empty-cells bug: `fix --out` wrote original headers but records are
  keyed by normalised keys; output now maps records back through the key list
  (regression-tested end-to-end).
- Closed licence-bypass: `--out -` and `--json` corrected records now require
  Pro (exit 3); free tier keeps the human-readable diff and change log.
- Fixed broken `npm test` script (`node --test test/` → glob) for Node ≥21.
- Added test/fix.test.mjs: Pro write round-trip + free-tier gate tests.

## Remaining work (distribution/monetisation, next loop iteration)

- Init a proper git repo for `revenue-ops` (it currently falls under the
  accidental home-directory repo) and push `03-paypreflight`.
- README with install/usage/licensing, npm publish, landing page, MCP listing
  (official registry / MCPize), launch channels.
- Continue the Revenue Operator loop: measure, next opportunity research.
- Human gates (npm publish, GitHub repo creation, licence secret management)
  belong in HUMAN_ACTION.md when attempted.

## Blockers

- None in code. Publishing needs credentials (human gate).

