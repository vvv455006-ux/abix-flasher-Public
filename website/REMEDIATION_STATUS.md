# Remediation status — 2026-11-05 23:25 CET (Europe/Berlin)

## Release and storage

- Production: https://abix-ninebot-flasher.vercel.app
- Production deployment: https://abix-ninebot-flasher-5zd8a0ds9-ozislercinar5-9827s-projects.vercel.app (`dpl_BCCMZVefbYBXHhAmanE7XyuWrTNb`). READY; public aliases assigned.
- Tested preview: https://abix-ninebot-flasher-olsq52u43-ozislercinar5-9827s-projects.vercel.app (`dpl_E4tBgqu4MFXQ9CYouYM12RgPRGrx`). READY; Vercel Authentication required.
- Preview and production release use the identical tested application commit `289dbc226dc2caeeea3e6475a46550486ffdf9f7`. A production-target build was made after the preview passed, rather than changing a preview deployment's alias and accidentally retaining preview environment/namespace configuration.
- Neon provisioning succeeded after the owner accepted integration terms. Resource `abix-flasher-licences`, Free (`free_v3`), region `iad1`, Neon Auth disabled. Integration linked its encrypted database configuration to production and preview. No further storage click is required.
- Integration dashboard: https://vercel.com/d/dashboard/integrations/neon/icfg_aAHxipWyUTbqgocwq2xrnE8s/resources/store_KJW8anSwiecGE4cx
- Production/preview data use distinct namespaces in the same database. Both contain exactly 28 migrated preserved licence records. Isolated test namespaces cannot consume customer credits. This is migration of the preserved snapshot, not a claim that historical in-memory balances were recoverable or independently reconciled.
- No linked repository was required for the release: source files were uploaded via the Vercel deployment API; Vite builds the React client and Vercel serves the Express API. Local Git has phase commits; no remote was created/pushed.
- `vexora.printspace.at` was not linked to this project and was not changed.

## Phase 1 — containment (commit 4a4b70e)

Removed the public administrator credential/autofill, fixed bearer bypass, PIN-disclosing errors, master-key shortcut and stateless licence resurrection. Rotated independent server-only signing/session secrets and a scrypt administrator verifier as sensitive Vercel variables in both environments. The raw new administrator credential exists ONLY at `.secrets/NEW_ADMIN.txt`, mode 600; `.secrets/` is mode 700 and excluded from Git and deployment. No credential values appear in this report.

Historical unique production deployment URLs and all previews remain behind Vercel Authentication, preventing public access to older secret-bearing assets. Previously leaked third-party credentials, if any, still require their issuer's revocation; removing source text cannot revoke an unrelated provider's token. Active/source anti-inspect traps and unsafe-eval requirements were removed.

## Phase 2 — durable access (commit 02594fa)

- Neon PostgreSQL stores hash-only licence verifiers, masked hints, entitlements, credits, binding, durable opaque sessions, rate limits, device enrollment, delivery attempts, ledger and audit events.
- New keys use server-only signing and random 192-bit payloads. Validation also requires an existing database row; arbitrary signatures never resurrect deleted records. New plaintext keys are shown once to an authenticated administrator.
- Admin/customer cookies are HttpOnly, Secure and SameSite=Strict. Database sessions are role-scoped, expiring and revocable. Protected mutations require same-origin/CSRF checks; admin/key login has shared durable rate limits.
- All 28 preserved records migrated idempotently into both environments. Exposed master remains present only as revoked. Existing bindings and legacy balance/status metadata were preserved; questionable legacy bindings require owner review, not silent unbinding.
- Credit debit, licence binding, delivery authorization and unique attempt ledger entry execute atomically in PostgreSQL. Concurrent one-credit attempts cannot both win. Same-attempt package retry is idempotent for 24 hours; revocation blocks redelivery. A network failure after authorized delivery may have already consumed a credit; a reviewed replacement credit is an admin operation, not an automatic exploitable refund.
- Catalog is allowlisted to four exact G3/F3 BLE images, validates bundled manifests/encrypted-file MD5, and publishes SHA-256 digests. Firmware bytes are not public static assets.

## Phase 3 — fail-closed engine and simulator (commit 5df2627)

Fixed receive framing to consume the second checksum byte (`length + 7`), with checksum validation and split/concatenated/noisy-stream handling. Kept 128-byte protocol blocks and NUS transport, fragmenting GATT writes into 20-byte segments. Added explicit profile-defined acknowledgments, bounded timeouts, retries only where the profile permits them, final digest/model verification, abort/disconnect cleanup and no confirmed-success event until verification succeeds. Unknown telemetry or identity and exact G3/F3 mismatch block the engine; fabricated real-device defaults are gone.

Simulator runs synthetic bytes and explicitly synthetic telemetry entirely in the browser; it does not need an access key and cannot call delivery/mutation endpoints or consume credits. Lost-ACK retry, verification failure, abort and disconnect are covered by tests.

**Real hardware is intentionally NOT operational or qualified.** There is no validated real G3/F3 telemetry decoder/ACK/verification profile in this release. Real connect is disabled in the UI and all server identity/delivery/completion endpoints return 503 while `REAL_FLASHING_ENABLED=false` and `HARDWARE_TEST_CONFIRMED=false` (both set in production and preview). A flag change alone cannot supply a qualified profile.

Server device binding requires a qualified enrolled Ed25519 signer proving a server nonce, exact model and firmware digest. That contract is tested with synthetic cryptographic fixtures; it is NOT evidence stock Ninebot bootloaders support attestation. Native hardware support, or a trusted enrollment/flashing bridge if native proof is unavailable, remains an integration decision requiring evidence. Browser-submitted UID/model/"completed" JSON is deliberately not trusted. Final installed-image verification must also be reconciled with the real bootloader's capabilities, not invented.

## Phase 4 — UI (commit 289dbc2)

Rebuilt the studio and admin portal with responsive PC/Android layouts, accessible labels/live progress, keyboard controls, explicit review/transfer/verification/result state transitions, safe stop, masked access/account details and an isolated simulator. Clear upfront notice: **iOS is not supported; use PC or Android Chrome**. Admin tools use durable authenticated sessions; legacy key secrets are not displayed. StarCFW is proprietary; it is not described as open source.

## Fresh verification performed

- 29 automated tests passed, 0 failed: React DOM interactions, state transitions, framing/model/telemetry/ACK/retry/final verification/abort, credential containment, durable storage/sessions/rate limits, concurrent credits and idempotent migration/device-proof fixtures.
- Client lint and Vite production build passed.
- Tested protected preview over the official Vercel CLI before production release. Then tested production: health/catalog, new admin session, retired admin/master rejection, unauthenticated admin rejection, masked 28-record listing, migrated customer key login/session and logout revocation. Disabled delivery/init/completion all return 503 and live-test customer credits stayed unchanged.
- Public production was separately checked without an authentication bypass. API reports `studio-6`, PostgreSQL and real flashing false. Static CSP/nosniff headers are present; preview redirects unauthenticated access to Vercel Authentication.
- Main and lazy administrator JS fetched from public production exactly match the tested local build bytes. Neither contains retired credentials, preserved raw licence keys, the new admin credential or the Vercel token. All 49 tracked application files also passed the known-credential scan before the documentation update.
- New administrator file permission verified as 600. Database URL encryption, sensitive server-secret types and both hardware-flag production/preview targets were checked by metadata only.
- Evidence: ignored `.vercel-state/preview-studio-verification.json`, `production-studio-verification.json`, `public-production-verification.json`, deployment JSON and environment metadata. Private sessions/recovery files are not evidence to share.

## Still requires the owner / hardware work

1. Supply actual G3 and F3 devices, bootloader/protocol captures and recovery equipment. Establish exact telemetry/model registers, ACK semantics, safe retry behavior and honest installed-image verification; implement/review qualified real profiles and browser delivery integration against that evidence. Run successful/wrong-model/disconnect/power-loss recovery tests on physical hardware.
2. Resolve trustworthy server-verifiable physical identity: confirm genuine native attestation support or select a trusted bridge. The browser cannot make an untrusted UID cryptographically trustworthy by itself.
3. Review preserved snapshot credits and legacy bindings before real delivery; do not silently assume they equal a consolidated historical live database.
4. Perform visual/keyboard checks on actual desktop Chrome and Android Chrome. DOM tests passed, but no real-browser/mobile/Bluetooth session was available here.
5. Only after the owner explicitly confirms qualification may the hardware flags be considered for enabling. Until then, simulator and licence/admin operations work; real flashing stays blocked.

Original pre-remediation findings and plan: `AUDIT.md`. Two pre-existing untracked local lab/test launchers remain untouched and undeployed. No secrets were printed or committed.
