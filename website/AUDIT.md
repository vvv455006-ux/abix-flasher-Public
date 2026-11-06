> Historical pre-remediation audit. For the deployed rebuild, verification results and remaining hardware limitations, see REMEDIATION_STATUS.md.

# Read-only audit: abix-ninebot-flasher

Audit date: 2026-11-05, approximately 22:56 CET (Europe/Berlin).
Scope: latest READY production deployment of the named Vercel project, its complete uploaded source, and public HTTP responses. No deployments, configuration changes, remote writes, admin login attempts, key generation, UID binding, credit consumption, firmware flashing, or deletions were performed. Only GET requests were used remotely. Local source files were downloaded as explicitly requested and not edited; this report and evidence JSON files were added locally.

## Executive verdict

**Do not treat the current installation as a secure licence service or a hardware-safe production flasher. Fix authentication and entitlement storage before investing in cosmetic changes.**

1. **Critical, publicly verified:** the live JavaScript bundle contains the administrator credential. The admin page displays it and provides an autofill button. The *same value* is the server's HMAC licence-signing secret and perpetual master access key. Anyone obtaining the public bundle can recover the signing material; no values are reproduced here.
2. **Critical, source-confirmed:** admin authorization also accepts a fixed bearer token, unrelated to a real expiring session. The PIN login error discloses the administrator credential for certain wrong-key inputs.
3. **High, source-confirmed:** credits, revocation and device locks live in a seeded JSON file copied into Vercel `/tmp`; sessions and rate limits live in process-local Maps. They are neither durable nor shared across workers. The stateless key fallback resurrects a validly signed key with one fresh credit and no device binding whenever the local record is missing.
4. **High, hardware safety:** the BLE receive parser consumes one byte fewer than the frame builder emits; important telemetry silently becomes fabricated defaults. Flashing does not await bootloader block acknowledgments or verify the installed image. Success can be announced even when backend completion fails.
5. **High, business/security:** the browser-supplied device identifier is not a silicon UID; credit consumption is optional client-triggered completion; firmware licence scope is not enforced; browser-side obfuscation cannot prevent a legitimate recipient copying firmware.

These are evidence of serious present weaknesses, **not proof of how the earlier hack occurred**. A specific previously leaked external API key was not identified in this snapshot. No Vercel token value was printed or saved by the audit scripts.

## 1. Provenance, project and deployment

| Item | Observed value |
|---|---|
| Project | `abix-ninebot-flasher` |
| Project ID | `prj_53xYwAvBDkRxOu4HG2o2I6HrCrva` |
| Vercel framework setting | `null` / Other; actual frontend is Vite + React |
| Linked Git repository | None returned by project API; no linked repository to audit |
| Deployment method | Vercel CLI (`source: cli`), not a linked Git integration |
| Latest production deployment ID | `dpl_9jTQNfSCLJK4YUPFcSj2NhK9HdNn` |
| Created | 2026-11-05 22:23:02.824 CET (Europe/Berlin) |
| State | READY, production |
| Production deployment URL | https://abix-ninebot-flasher-c19a9y8ck-ozislercinar5-9827s-projects.vercel.app |
| Primary production alias | https://abix-ninebot-flasher.vercel.app |
| Additional assigned alias | https://abix-ninebot-flasher-ozislercinar5-9827s-projects.vercel.app |
| Configured custom domains | None returned; project domain list contains only the primary Vercel alias |
| Git provenance in CLI metadata | branch `master`, SHA `db9b55f3a436d5f10d97463a5a71e852bcc3ce83`; this is not proof of a linked remote or source history |
| Build | `cd client && npm install && npm run build` |
| Output | `client/dist` |
| Runtime / region | Node.js `26.x`; `iad1` |
| Project environment variable NAMES | Empty list returned. No environment values retained. Source references platform/runtime names `VERCEL` and `PORT` only. |

**Related domain caveat:** https://vexora.printspace.at returned a different public page titled “OPENX3 — Custom Firmware für deinen G3 & F3 Pro”. It is **not** attached to this project's returned domains or deployment aliases, and no application-source reference to that host was found. It may be related operationally, but this audit does not establish shared hosting, backend, keys, ownership configuration, or code. Do not assume this project's redo updates that domain.

### Acquisition and integrity

- Used authenticated GET `/v9/projects/abix-ninebot-flasher`, project env/domain listing, `/v6/deployments`, `/v7/deployments/{id}/files`, `/v8/deployments/{id}/files/{fileId}`, deployment details and aliases. The token was read from `VERCEL_TOKEN` only for the Vercel API authorization header.
- Retrieved **157/157 uploaded source files**, **15,774,479 bytes**, to `/workspace/abix-flasher-src/`, removing only the API tree's leading `src/` directory wrapper. Binary firmware and image assets were included.
- **157/157 source SHA-1 digests match the API file UIDs.** The compiled `out/api/index` lambda descriptor is not a source file and was not downloaded as source.
- Public `/assets/index-Bm4uUVtQ.js` is 343,728 bytes and byte-identical to uploaded `client/dist/assets/index-BuNu8AQk.js`. Credential presence was checked as booleans, without outputting the values.
- Evidence: `vercel-metadata.json`, `deployment-details.json`, `deployment-file-tree.json`, `download-manifest.json`, `public-http-observations.json`, `public-bundle-observations.json`, `secret-findings-locations.json`.
- No dependency installation, downloaded test suite, local application server, or source build was run. The bundled test script mutates its datastore and prints generated credentials, so it was intentionally not executed. No physical scooter or BLE radio was tested.
- This is a manual source/security review plus narrow credential-pattern checks, not a complete SAST/SCA, penetration test, malware attestation, or Git-history review. Dedicated cloud-code/scanning tools were not available in this executor.

## 2. Stack and file structure

Resolved lockfile versions: React / React DOM 19.3.1, Vite 8.3.5, Tailwind CSS 4.3.4, Lucide React 1.68.0; Express 5.3.0, CORS 2.8.6, Multer 2.5.0. JavaScript/JSX ES modules; no TypeScript, durable database SDK, or established authentication library in this source. Python/Unicorn-related emulator tooling is auxiliary, not the deployed browser BLE transport.

```text
api/index.js                       exports Express app for Vercel function
server/app.js                      public flasher + administrator HTTP endpoints
server/db.js                       JSON storage, key minting, signing, credits
server/data_store.json             bundled settings, plaintext keys and logs
server/firmware_service.js          catalog, UID binding, flash sessions, chunks
server/firmware_storage/<mod>/      FIRM.bin.enc + info.json (4 variants)
server/emulator_core/              local Python BLE/display emulator, captures/tools
server/index.js                    local Express listener (not Vercel entrypoint)
client/src/App.jsx                 in-memory login/admin/tab state
client/src/components/
  KeyLoginGate.jsx                 access-key form
  FlasherWizard.jsx                six-step flow, selection, pairing, streaming
  AdminPortal.jsx                  active administrator UI
  AntiInspectShield.jsx            keyboard traps / debugger overlay
  ScooterHudPreview.jsx            display preview, not a protocol validator
  Navbar.jsx                       tabs, credits, audio, logout
  AdminStudio.jsx                  legacy/unreferenced admin implementation
  LicenseChecker.jsx               legacy/unreferenced licence check UI
client/src/services/
  ninebotBleService.js             model heuristics, NUS UART framing, flash loop
  soundEffects.js                  Web Audio effects
client/src/index.css               Tailwind + cyber/glow/animation styles
client/dist/                       uploaded prebuilt frontend copy
client/vite.config.js              React/Tailwind; dev /api proxy to :3001
vercel.json                        build, firmware includeFiles, API + SPA rewrites
temp_extracted/                    duplicate firmware payloads/manifests
project_export.json                stale operational export, includes credentials
README.md / test_complete_rebuild.mjs
```

`vercel.json:5-19` includes firmware in `api/index.js`, rewrites `/api/*` to the function and all other paths to static `index.html`. Local Express has a fallback static server, but production static assets are served by Vercel, not by the Express security middleware. Build uses `npm install`, not reproducible `npm ci`; source snapshot includes both source and redundant build/temporary artifacts. There is no linked Git CI configuration or automated hardware acceptance gate visible here.

## 3. UI audit

### How it works

`App.jsx` conditionally renders a login gate, an admin portal, or the studio based on React state. Admin access is exposed through a button or an `admin` substring in the path/query; this routing is not an authorization boundary. Successful key login returns key details, kept in component state, then renders six steps: choose mod → pair → bind UID → safety checks → progress → success. A second tab renders the animated HUD preview. Styling is mostly inline Tailwind class strings, dark monochrome panels, very small uppercase monospace labels, glow effects, sounds and confetti. Four firmware descriptions/sizes are hardcoded in the wizard rather than read from the server catalog.

### Main weaknesses

- **Security mixed with presentation:** publicly bundled admin secret and autofill; anti-inspect code masquerades as DRM. Remove secrets and rework server authorization, not merely hide the admin link.
- **Dangerous lifecycle:** navbar tab switching/logouts remain enabled during flash (`Navbar.jsx:14-16,57-79,123-129`); tab changes unmount the wizard while its async loop continues in a singleton service. `App.jsx:32-39` clears display state but never disconnects GATT or cancels work. Wizard log subscriptions have no cleanup; reconnect/disconnect state is not propagated back to its React state.
- **False assurance:** fabricated UID/telemetry are labelled hardware/silicon checks. Completion celebrates before device integrity is established. The catch message promises no credit deduction even if completion had already reached the server (`FlasherWizard.jsx:308-311`).
- **Production simulation has real side effects:** the visible simulator calls the same bind/session/complete API and can bind or consume real customer keys (`FlasherWizard.jsx:164-209,256-285,492-535`). No backend sandbox marker exists.
- **Browser support appears too late:** feature detection happens only when connecting. A user can enter a key before learning their browser cannot flash. iOS should be explicitly blocked up front; direct users to tested desktop/Android Chrome rather than make universal browser promises.
- **Accessibility:** clickable mod cards are `div` elements without button/radio semantics or keyboard focus (`FlasherWizard.jsx:405-415`); key input labels are not associated through IDs; global shortcut/right-click suppression and `select-none` hurt accessibility and support. Text often uses 10–11px sizes and dark gray. Animated borders/sonar/confetti have no reduced-motion treatment in the reviewed stylesheet.
- **Intrusive anti-debugging:** an 800ms dynamic `debugger` trap and window-size heuristic can falsely cover the entire UI or pause the event loop while flashing (`AntiInspectShield.jsx:88-112`). It is bypassable and obstructs diagnosis. It also encourages unsafe CSP exceptions.
- **Maintainability:** roughly 842-line wizard, 963-line admin portal and large preview mix transport, API calls, state, effects and rendering. Catalog data is duplicated across client/server/db. Legacy `AdminStudio` uses obsolete/missing endpoints and no admin headers; `LicenseChecker` calls an absent route. They are not imported by the active app, but are confusing maintenance hazards.
- **Polish:** public document title remains `client`; raw licence keys appear prominently in several UI panels. No durable authenticated session survives refresh, and no recoverable attempt summary replaces the eight-second auto-logout.

## 4. BLE flashing: mechanism and findings

### Implemented mechanism (not independently validated against a scooter)

- Uses Web Bluetooth chooser name prefixes plus Nordic UART Service UUID `6e400001-b5a3-f393-e0a9-e50e24dcca9e`; RX characteristic suffix `0002` is written, TX suffix `0003` notifies. An additional vendor service is requested as optional but never actually used.
- Constructs `55 AA | length | target | source | command | register | payload | checksumLE` frames. Source is `0x3E`; dashboard, ESC and BMS targets are `0x20`, `0x21`, `0x22`. Checksum is the complemented byte sum, not a cryptographic integrity check.
- Reads serial via ESC/BLE register `0x10`, model via ESC `0x1A`, and battery via BMS `0x31`. Waits approximately 400–700ms per query, resolving only one hardcoded response-command variant.
- Backend loads the existing `FIRM.bin.enc` into RAM. `info.json` manifests exist but are not read by the flash service. Four images are 1,988,440–2,012,416 bytes, giving **15,535–15,722** sequential 128-byte HTTP chunk requests.
- Session initiation returns a random token and a random session XOR key. Each encrypted chunk is recovered by browser XOR with a deterministic salt; an HMAC and simple XOR checksum are returned too.
- Sends IAP enter (`command 0x07`, register `0x01`), waits 200ms, writes block packets (`0x08`) with a 16-bit block index, then IAP finalization (`0x07`, register `0x02`) and waits 600ms. Calls backend `/complete` and returns success.
- HTTP fetches retry three times at 400ms; BLE write API errors retry three times at 150ms. A screen wake lock is attempted. These are API-call retries, **not** a demonstrated bootloader sliding-window/ACK/retransmit protocol.

### High-priority defects and risks

**B1 — Off-by-one receive framing, high, source-proven.** `buildPacket` sets `length = payload.length + 2` and emits `payload.length + 9` bytes (`ninebotBleService.js:216-229`). Parser consumes `length + 6`, or `payload.length + 8` (`:247-268`). A one-byte payload produces a 10-byte packet, but parser consumes 9. Thus builder-compatible replies are truncated and checksum reads are misaligned. This arithmetic was independently checked without importing application code. Validate the real protocol from captures before choosing the correct convention.

**B2 — Telemetry fails open and is misleading, high.** Missing responses default to 85% battery / 40.5V; missing serial is fabricated; firmware version is hardcoded; speed is always zero and charging always false (`:436-493`). The BMS conversion derives both percentage and voltage from overlapping bytes without an established schema. Preflight therefore does not prove safe battery or stationary state. Read failures must stop flashing, not manufacture safe values.

**B3 — Not a true silicon UID, high.** `:479-488` derives the identifier from Web Bluetooth `device.id` before serial, strips/truncates it and labels it `NB-STM32`. Browser device IDs are opaque browser/origin-scoped identifiers, not MCU silicon IDs; changing browser/origin/profile can change the binding. Server accepts this identifier from arbitrary request JSON with no device proof. Current device lock is bypassable client assertion, not hardware-enforced DRM.

**B4 — G3/F3 enforcement is only broad-family and bypassable, high.** `identifyModel` intentionally groups G30/G2/MAX with G3 and F2/F40 with F3, and defaults unknown devices to G (`:31-143`). Frontend preflight compares only initial g/f (`:542-547`). Backend uses similar heuristics, skips comparison if model is omitted, and trusts the request (`firmware_service.js:189-208`). Conflicting evidence is not explicitly rejected. Exact G3-vs-F3 cross-family conflict is blocked in the normal honest-client path, but **exact board/model compatibility is not enforced**. Manifest `enforceModel`, `compatible` and type fields are ignored.

**B5 — No device ACK or install validation, high.** Blocks use `writeValueWithoutResponse`, with no matching bootloader acknowledgement, block sequence confirmation, erase/program status, final image hash, version readback or reboot verification (`ninebotBleService.js:593-597,653-677,720-747`). GATT completion is not proof the bootloader accepted bytes. Backend chunk `mac` and `crc` are not verified by the client. The validity of this simplified IAP protocol on these particular firmware/bootloader versions remains unproven.

**B6 — Transport size/capability handling absent, high reliability risk.** A full block packet is **139 bytes** (128 firmware + 2 block index + 9 framing), exceeding a default 20-byte ATT value. It may work only with suitable negotiated characteristics/MTU or implementation behavior. No supported-size probing, application fragmentation or characteristic capability negotiation is implemented. Register queries assume write-with-response exists; block writes assume write-without-response exists.

**B7 — Serverless sessions + request-per-128-bytes, high.** `activeSessions` is an ordinary Map; another instance cannot serve a token. Any worker change can interrupt flashing. Sessions last nominally 15 minutes, leaving only **57–58ms per chunk on average** for the whole HTTP + BLE loop at these image sizes; there is no prefetch pipeline. At 100ms per chunk, transfer alone takes about 26 minutes. Cleanup checks expiry on an interval; chunk/complete handlers do not enforce `expiresAt` directly. A frozen/background timer is not reliable authorization expiry.

**B8 — Silent false success and missing cleanup, high.** Client does not check `completeResp.ok` or `completeResult.success` before returning `success: true` (`:730-746`). No `try/finally` covers the wake lock; no network timeout, cancel signal, flash abort/recovery state, or safe resume exists. Disconnect updates a service boolean, not the wizard, and does not reject all outstanding requests immediately. If disconnected/reconnected state leaves no RX characteristic, the flashing branch can use simulated delays rather than fail closed (`:665-681`).

**B9 — Manifest/crypto boundary is unclear.** All four bundled manifest MD5 values match their downloaded encrypted binaries; this checks at-rest consistency, not signed authenticity. The runtime never uses these manifests. It strips only its own XOR wrapping, then sends encrypted file bytes as-is. Auxiliary Python tools implement NinebotTEA, but that is not integrated as a verified bootloader/package-validation contract. No ZIP-import validation or browser ZIP parsing exists in the active application; current images are pre-extracted folders. Do not infer full ZIP/protocol support from the UI/documentation.

## 5. Licence/access-key system

### Actual lifecycle

1. Admin supplies PIN, receives a fixed token, and active admin UI subsequently sends the raw PIN in `x-admin-pin` for requests. There is no real administrator session lifecycle.
2. `db.createKey` generates four random bytes (32 random bits), adds a mod prefix, and appends the first eight hex characters (32 bits) of HMAC-SHA256 over its payload (`db.js:102-109,254-280`). Custom keys are normalized/truncated and signed. No expiry, durable unique-key constraint, or strongly bounded credit schema exists.
3. Plaintext keys/credits/customer/device fields are stored in `data_store.json`. On Vercel, a bundled seed is copied into `/tmp/data_store.json` (`db.js:9-11,117-128`). Seed contains **28 current keys (25 marked active with positive credits), 4 legacy licences, 27 logs and 3 firmware-lock records**. These are bundled snapshot records, not a claim about current shared production balances.
4. Lookup accepts a hardcoded master key as a fresh virtual record with 999 credits and no lock, checks the local JSON list, or reconstructs a missing HMAC-valid key with **one credit, active status and no lock** (`:165-248`).
5. `/login-key` validates key existence/status/credit server-side, returns key metadata, and merely unlocks React state. No customer access session is issued; the raw key remains the credential for subsequent authorization.
6. Verify/init accepts user-provided UID, serial, model and selected firmware, optionally binds the key to that UID, reads the binary and creates a process-local streaming session. It does not reserve credit or verify physical hardware.
7. `/complete` trusts the token and decrements one stored credit, logs success and deletes the Map entry. It does not require delivery of all chunks or device success. Normal client simulation follows this exact real-credit path.

### Security findings

| ID / priority | Finding and impact | Evidence |
|---|---|---|
| K1 Critical | Admin credential is public client content, and exactly equals the HMAC signing secret and master flasher key. Recovery permits administrator access and minting apparently valid licence keys. Changing only the PIN does not remove all hardcoded backdoors. | `AdminPortal.jsx:326,336,346,363`; live-bundle presence verified; `db.js:17,102,170` |
| K2 Critical | Fixed bearer authorization can bypass PIN authentication; token is not random per login, expiring, revocable, audience-bound or validated against a session store. Wrong-key login branch discloses PIN before counting failure. | `app.js:250-263,285-297` |
| K3 High | `/tmp` database and in-memory maps fragment/reset across workers/redeploys; balances, revocations and locks can revert. File rename only protects a single local write, not a distributed transaction. Save/read failures are swallowed or fall back to permissive defaults. | `db.js:117-157,329-351`; `firmware_service.js:10-26` |
| K4 High | Stateless fallback recreates deleted/missing keys with fresh credit/no lock and loses custom credit totals/customer/scope state. Deleting a signed key does not durably revoke it. Master lookup ignores stored lock/balance and always yields a fresh privileged record. | `db.js:169-248,385-389` |
| K5 High | No credit reservation; many sessions can start while one credit remains. A client can retrieve firmware and never call complete, or complete without flashing/receiving any chunks. Completion is not bound to IP and does not revalidate session expiry. A session-local flag is not cross-worker idempotency. | `firmware_service.js:288-355,442-485` |
| K6 High | A key's licensed firmware/model scope is not enforced: any allowlisted selected mod is accepted if it matches the asserted family. First binding can overwrite the preferred file. Unknown selected IDs are normalized for verification but the original unchecked ID is reused for `path.join` in initialization. This permits path escape to other accessible directories containing the fixed filename `FIRM.bin.enc`, not unrestricted arbitrary-file reading. | `firmware_service.js:186-218,304-309` |
| K7 High | All device/model/telemetry claims originate in browser JSON. Omitting model skips model checks; UID can be forged/replayed. Battery level is stored but never enforced server-side. Simulation is not isolated. | `firmware_service.js:172-208,288-339`; `ninebotBleService.js:479-493` |
| K8 Medium | Rate limiting is per-process only; direct key-status lookup bypasses login attempt tracking. Arbitrary forwarded-IP strings are used without explicit normalization/trust-boundary handling. Whether a client can spoof these headers depends on Vercel's proxy behavior and was not tested. Admin protected operations do not apply the PIN-login lockout. | `app.js:98,110-135,236-297`; service rate-limit Maps |
| K9 Medium | Raw keys and customer/device data are returned extensively and logged in plaintext; query-string credentials supported for key-status, chunks and admin PIN risk exposure in access logs/history/telemetry. CORS is wildcard. This does not grant authorization by itself, but broadens exposure when a credential leaks. | `app.js:112-129,201,287`; `db.js:393-405` |
| K10 Medium | 32-bit nonce/tag are unnecessarily short; custom normalization and no uniqueness constraint permit collisions/duplicate credentials. No durable revocation, expiry or audit ledger exists. | `db.js:104-109,259-315` |

### Why the current “DRM” does not protect the firmware

The backend returns the XOR key to the same browser that receives every encrypted chunk. A user can record bytes before/after the BLE call, reconstruct all chunks, or skip the credit-completion call. `rawBytes.fill(0)` does not erase copies already created in packet arrays, browser internals or instrumentation. The chunk HMAC is not checked; the client also has the HMAC session key. Sequential HTTP requests/IP binding and blocking filename extensions do not solve this trust problem. Even sequential enforcement accepts any initial chunk and earlier chunks (`firmware_service.js:388-399`). Strong anti-copy claims are not achievable solely in JavaScript delivering reusable firmware to an untrusted client. Hardware-enforced signed/device-bound payloads require actual bootloader/device support.

## 6. Exposed secrets and sensitive material — names/locations only

**Values intentionally omitted. Treat the administrator/master credential and signing secret as compromised.**

| Material | Locations |
|---|---|
| Administrator PIN / master access key | `client/src/components/AdminPortal.jsx:326,336,346,363`; uploaded `client/dist/assets/index-BuNu8AQk.js:10`; publicly served matching `/assets/index-Bm4uUVtQ.js`; `server/db.js:17,25,170,173`; `server/app.js:250,262,288`; `server/data_store.json:8` and additional key/log records; `server/index.js:10`; `project_export.json:10,123,260` |
| `HMAC_KEY_SECRET` | `server/db.js:102`; **same value as the publicly exposed administrator/master credential**, so its effective exposure includes the client locations above |
| Fixed admin bearer token | `server/app.js:254,293`; do not replace it with another hardcoded constant |
| Seeded current/legacy access keys | `server/data_store.json` fields `keys[].key`, `licenses[].key`, `flashLogs[].key`; default/test keys in `server/db.js:22-97`; example legacy credentials in `README.md:70-77` |
| Firmware-format symmetric key constants | `server/emulator_core/emutools/tea.py:7` (`KEY_HEX`), `server/emulator_core/visuals-ble/package_ble.py:21` (`KEY`). These are firmware-format cryptographic material, not proof of a leaked external API account key. Do not assume firmware confidentiality based on them. |
| Customer names, scooter identifiers, IPs, raw licence credentials | Bundled datastore/logs and export; do not include them in a production seed or unrestricted telemetry |

Narrow patterns found no recognizable AWS access key, GitHub token, Slack token, Stripe secret, Telegram bot token, JWT credential, or private-key block. This is **not proof of absence**: the audit has no Git history, original ZIP repository, previous deployment source analysis, account logs, or external backend configuration. The specific historical API-key incident is unresolved. This report never reproduces any credential value; the downloaded source necessarily retains the original code/material as requested and should be handled privately.

## 7. Deployment/browser security observations

Public GET `/` returned HTTP 200, title `client`, HSTS, but **no CSP, X-Frame-Options, nosniff, Referrer-Policy or Permissions-Policy**. The static frontend therefore does not inherit the Express middleware's apparent hardening. `/api/firmwares` returned 200 and those Express headers, but its CSP allows unsafe inline scripts/eval. Both returned wildcard CORS. API middleware blocks filename extensions, not authorization bypasses. A malformed URI can throw in `decodeURIComponent` before route handling; input shapes/types generally lack schema validation and exception messages are sent to clients. No known injection exploit was exercised.

Put document/security headers at Vercel's static response layer, remove dynamic anti-debug/eval code, validate request bodies strictly, limit CORS to intended origins, and apply durable rate limiting. Do not store credentials in source, query strings, HTML, public assets or documentation. A dependency advisory scan was not performed; no unsupported claim about package CVEs is made.

## 8. Concrete prioritized redo proposal

This is a proposed scope, **not implementation approval and not a claim that anything has been changed**. Estimates are engineering days for one experienced full-stack/BLE engineer, with working hardware, known-good firmware and recovery equipment available; product decisions/reverse engineering can add time.

### Approach choice

1. **Recommended:** retain Vite/React and Vercel hosting, replace unsafe internals with TypeScript boundaries, an authenticated API, managed PostgreSQL, optional Redis for throttles/ephemeral coordination, and private versioned firmware object storage. Lowest UI migration cost; fixes the actual trust/state issues.
2. Long-lived dedicated backend can simplify transport state, but still requires a durable database, proper auth and the same BLE protocol work. It is not a fix by itself and adds operations.
3. Native desktop/Android companion can improve BLE control/recovery, but adds installation/signing/support work and does not magically prevent copied payloads. Consider only if verified browser/bootloader constraints demand it; do not add iOS support promises.

### P0 — Contain exposure before expanding use (0.5–1 day)

With owner approval in a separate change: restrict/disable exposed administrator and flash endpoints while recovering; remove all public PIN/autofill/error disclosures, fixed bearer authentication, master bypass and source-secret copies. Rotate/revoke old administrator/signing credentials and invalidate old signed keys/sessions through an explicit migration policy. Merely rotating a Vercel env token would not repair these application backdoors. Inspect Vercel access/account/deployment logs, previous deployment aliases, Git history if recovered, and the separate vexora service for the historical incident. Preserve evidence first; do not blindly delete production records. None of these changes were made in this audit.

### P1 — Redo the key system (5–8 days)

- Replace global PIN with OIDC/passkey-backed administrator accounts + MFA, server-enforced roles, short-lived sessions and an auditable support workflow. Keep administrator UI separate/lazy-loaded, while acknowledging hiding a URL is not security.
- Generate at least 128 bits of random access-key material; show it once and store a non-reversible verifier (e.g. SHA-256 over a high-entropy token, or HMAC using a distinct server-only pepper). Redact logs; never return full keys again. Separate administrator, signing and session secrets using environment/secret management; no VITE/public secret variables.
- PostgreSQL records: licences, firmware entitlements, device bindings, credit ledger, attempts, sessions and admin audit events. Uniqueness, explicit status/expiry and durable revocation. No JSON seeds or stateless resurrection. Recover actual customer balances from trusted records, not automatically from the shipped test snapshot.
- Redeem access key into Secure/HttpOnly/SameSite customer session cookies; validate Origin and use CSRF protection for state-changing cookie-authenticated routes. Short-lived capability tokens must be scoped to licence, firmware digest, attempt and expiry, not accepted as global admin tokens.
- Transactionally reserve one entitlement/credit for a uniquely identified flash attempt; use idempotency keys, one active attempt per permitted scope, resumable retries and an explicit failed-attempt/refund/support policy. Do not make optional browser completion the economic enforcement point. A browser cannot honestly prove a successful flash without device attestation; define this limitation in the billing policy.
- Enforce exact licence firmware scope; schema validation and immutable catalog IDs; map IDs to trusted paths rather than accept paths. Durable/distributed rate limiting by account/key/IP with proxy normalization, bounded quotas and real expiration checks.
- Device binding: use verified device identifiers where supported, but label browser IDs/serial claims as best-effort. Cryptographic device attestation or signed per-device firmware is only possible if the target hardware/bootloader supports it. Never claim tamper-proof STM32 locking from browser JSON.

Acceptance: unauthorized admin requests fail; no admin/signing material in browser bundles; revoked keys stay revoked across cold starts; parallel requests cannot overspend; duplicate completion is idempotent; retry/failure policy is tested; wrong firmware scope/unknown IDs are rejected; migration preserves real entitlements.

### P1 — Redo the Bluetooth flasher (10–20 days, hardware-dependent)

- First obtain known-good captures/specification for each exact G3/F3 BLE board/bootloader and firmware package format. Verify pairing/auth/encryption and IAP sequence. Use recoverable bench devices; do not infer compatibility from a family name or the existing emulator.
- Separate pure packet codec/parser, UART transport, device-profile/telemetry reader, package validator and deterministic flash state machine. Explicit states for connect → authenticate → identify → validate → transfer → device verify → reboot → confirm; every uncertain/unknown state fails closed.
- Correct framing with capture-backed golden vectors; streaming parser tests for split/concatenated frames, invalid lengths, checksum errors and noise. Match all legitimate reply variants and reject unexpected target/source/command/sequence.
- Respect actual characteristic capabilities and supported payload size. Add fragmentation if needed, bounded queues/backpressure, device ACK/status checks, retry budget/backoff and reliable final checksum/version readback. Resume only if the bootloader documents safe resume; otherwise provide a specific recoverable restart workflow.
- Read real battery/voltage/stationary/charging/serial/version data with explicit unknown states and freshness. Exact board/model/revision compatibility from validated manifests. Reject G30/G2/F2/F40 and unknown devices unless separately proven compatible; reject conflicting identity evidence.
- Validate imported/prestored `FIRM.bin.enc` + `info.json` schema, component/type, allowed versions, size and cryptographic digest; use signed manifests for authenticity. If ZIP import is added, limit expanded size/entries and reject path traversal/duplicates. Do not treat MD5 as an authenticity signature.
- Replace 15k per-image HTTP calls with authorized bounded streaming/prefetch or one attempt-scoped package fetch, independent of device block size. Durable authorization/session state; no worker affinity assumption, no brittle IP pinning. Accept that an authorized browser can copy delivered bytes unless hardware cryptography changes that boundary.
- `try/finally` cleanup, abort/timeouts, disconnect propagation, explicit recovery guidance, wake-lock reacquisition and safe navigation guards. Simulator uses mocks/test storage and cannot bind/burn production entitlements.

Acceptance: codec vectors and fault-injection tests pass; all G3/F3/wrong-board combinations behave correctly; real transfer has verified bootloader ACK/final readback; disconnects/timeouts/refresh failures do not claim success or double-charge; physical Android Chrome and supported desktop Chrome matrix is exercised. Additional proprietary/authentication reverse engineering may add **1–3+ weeks** beyond this range.

### P2 — Redo the UI (3–5 days)

- Accessible mobile-first workshop rather than “military DRM”: calm typography, status hierarchy, readable labels, meaningful color and optional reduced-motion/audio. Remove anti-inspect, debug traps and security claims that cannot be fulfilled.
- Show compatibility/browser requirements before key redemption. Explicit “not supported on iPhone/iPad; use tested desktop/Android Chrome.” Explain firmware risks, exact compatible device and credit/retry policy before beginning.
- Recommended flow: verify access → connect/identify exact device → show only compatible entitled firmware → review live checks → explicit flash confirmation → transfer + device-verification stages → persistent result/recovery receipt. No silent automatic firmware substitution.
- State-machine-driven UI with one active attempt, safe tab/logout handling, errors inline rather than alerts, accessible radio cards/buttons, associated form labels, progress announcements, keyboard support and failure recovery. Keep secrets masked and result available rather than forced logout/confetti.
- One server-driven catalog; small typed components/hooks; independent preview/demo with zero production side effects. Route/lazy-load administrator tools; remove obsolete implementations and template metadata.

Acceptance: keyboard/screen-reader flow, narrow Android layout, unsupported-browser screen, reduced-motion mode, interruption/recovery and no accidental simulator charge all pass.

### P2 — Integration, hardening and release qualification (2–3 days)

Add CI with `npm ci`, lint/typecheck, unit/API/concurrency/browser tests, secret scanning and dependency review. Apply strict CSP/security headers to static HTML as well as API, remove unsafe-eval dependency, redact observability, version firmware artifacts, add database backup/restore and operator rollback runbooks. Rehearse key migration and fault recovery in staging before a separately approved release. Firmware application rollback is hardware-dependent; do not assume Vercel website rollback undoes a scooter flash.

**Planning total: approximately 20.5–37 engineer-days (about 4–8 working weeks solo), plus hardware/protocol unknowns.** UI can run in parallel after the API/state contracts are fixed. Recommended sequence: contain credential exposure → durable key/auth/attempt model → prove BLE protocol and safety → integrate redesigned UI → staged hardware acceptance. No automatic deploy or deletion is part of this audit.

## Reference documentation

- Vercel source listing / content retrieval: https://vercel.com/docs/rest-api/deployments/list-deployment-files and https://vercel.com/docs/rest-api/deployments/get-deployment-file-contents
- Vercel function isolation/filesystem: https://vercel.com/docs/functions/runtimes
- Invocation/instance lifecycle: https://vercel.com/docs/functions

Primary evidence is the exact downloaded production source and the narrow live public HTTP checks above; protocol validity and the historical compromise remain unverified.
