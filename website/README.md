# ABI FLASHER — Ninebot G3 & F3

![ABI FLASHER](client/public/abi-flasher-logo.svg)

Operated by **@f3Prompt**. Black interface, white type, monochrome accent; the same layout on desktop and phone. Strictly black & white: every colour in the UI, the diagnostic page, the logo/favicon and the icons is a pure grey — errors are an inverted white block, warnings a dashed border, never a colour. Images are forced to greyscale in CSS.

Key-gated display-firmware studio. The page opens on the key window and nothing else: the studio renders only after a key verifies. Real-device flashing is disabled pending owner-confirmed hardware tests AND a qualified device protocol/attestation profile. A browser run is not hardware certification.

## The gate
Every visit starts at the key window. A key is `ABI1.<base64url>` — a signed payload (version, 6-byte id, issue minute, validity days) signed ECDSA P-256 by the operator master key. The build carries only the public half (`PUBLIC_KEY_SPKI` in `client/src/services/accessKey.js`), so any device verifies offline and nothing in the bundle can mint a key. A verified key is remembered in `localStorage` and checked again on the next visit; an expired, forged or exhausted key is dropped and the gate returns.

Operator master key (= Admin Key): generated once, kept in `.secrets/abi-keymaster.txt` (gitignored, never bundled). Paste it into the gate to open the studio as operator, or into the generator at `#admin` to sign keys for users. The page forgets it on reload.

## ABI ADMIN — Key-Generator mit Credits
`#admin` is a two-step flow. **Step 1 — Admin-Login:** paste the Admin Key (the master key). It is checked against the public half of this build (`masterMatchesSite`) and kept only in page memory — never stored, never sent. **Step 2 — Key-Generator:** choose **Credits pro Key (1–1000)**, validity in days (0 = unlimited) and how many keys (1–25). Each key is an `ABI1` v2 key: the credit total is part of the signed 15-byte payload, so nobody can raise their own balance. Keys can be copied one by one, all at once, or downloaded as `.txt`. „Diesen Key verwenden“ logs the admin straight in with that key.

**1 Credit = 1 Flash.** The credit is spent by the server when the firmware image is delivered for a flash (`GET /api/studio/image/:id?mode=flash`), atomically, before any bytes are sent — a delivery is a delivery, even if the Bluetooth transfer afterwards fails. „Bild prüfen“ (`?mode=probe`) spends nothing, but still needs at least 1 credit left, because the full image is delivered. Balance: `GET /api/studio/credits`. Used credits are counted server-side in `server/credits.js` — in Postgres (`flasher_studio_credits`, see `server/schema.sql`) when `DATABASE_URL` is set, otherwise in the gitignored file `server/data/studio-credits.json` (single server only). Without a server the count is kept locally per key on that device (`abi.flasher.used.<id>` in localStorage) and shown as „nur auf diesem Gerät“ — that local counter can be cleared with site data, so it is a display, never proof. The studio shows the balance in the Access panel and above the firmware list, and blocks flashing at 0 credits. The gate also refuses a key with no credits left.

Legacy v1 keys (13-byte payload, no credits) still verify and are shown as „Legacy-Key, ohne Credits“ — they are not charged. Reissue them as v2 keys to put them on credits.

## Catalog
The firmware catalogue ships inside the bundle (`client/src/data/catalog.js`), so the studio works with no API at all — `npm run build --prefix client` and serve `client/dist` from any static host. When the API answers, its catalogue (with real image sizes and digests) replaces the bundled one. Nothing about a scooter is uploaded anywhere.

## Runtime
Vite/React frontend; Express API; Neon PostgreSQL. Production and preview use separate namespaces within the provisioned database. Browser assets contain no administrator or signing secrets.

## Required server configuration (names only)
DATABASE_URL, ADMIN_CREDENTIAL_HASH, SESSION_SIGNING_SECRET, KEY_SIGNING_SECRET. The latter three must be Vercel sensitive variables. REAL_FLASHING_ENABLED=false and HARDWARE_TEST_CONFIRMED=false in both environments. Never set either flag true without physical qualification; a flag alone does not supply a qualified profile.

## Development / verification
`npm run dev` (API on :3001, page on :5173). The page works without the API; the API is only needed for the operator console and licence records.
`npm ci && npm ci --prefix client`
`npm run test:unit`
`node --env-file=.secrets/runtime.env --import tsx --test tests/*.test.mjs client/tests/*.test.jsx`
`npm run lint --prefix client && npm run build --prefix client`
The integration suite uses isolated PostgreSQL namespaces and never consumes customer credits. Browser DOM tests are not physical browser/Bluetooth qualification.

## Migration
The operator-only `scripts/migrate.mjs` reads the ignored private legacy snapshot, imports all 28 preserved records idempotently into production and preview, stores only key hashes/hints, and revokes the exposed master. It never recreates missing signed keys. Review legacy balances and bindings with the owner before re-enabling real delivery.

## Billing / recovery
A paid attempt is charged atomically at first authorized firmware delivery, not optional completion. Retries for the same attempt are idempotent for 24 hours; an interrupted response may already have consumed the credit. Support can grant a reviewed replacement credit. Final completion requires qualified device-signed digest evidence. Browsers cannot provide hardware attestation by inventing a UID.

## Branding
All product names in the interface are ABI FLASHER (ABI DASHBOARD, ABI Firmware, ABI TOOL). The mark is a lightning bolt cut into a white tile with black type: `client/public/favicon.svg` for the tab, `client/public/abi-flasher-logo.svg` for the wordmark lockup, and the same bolt inline in the header. Device names (Ninebot G3, MAX G3, F3), firmware display names from the manifests, and protocol provenance comments stay exactly as they are: they identify hardware and third-party firmware, not this product, and relabelling them would falsify what is being flashed.

## Platforms
The key gate accepts a paste on any device. The Bluetooth check needs Web Bluetooth: Chrome or Edge on a PC, or Chrome on Android. iOS is not supported for Bluetooth.

Original findings: AUDIT.md. Operator status: REMEDIATION_STATUS.md. Secrets/recovery files are local-only and excluded from Git/deployments.
