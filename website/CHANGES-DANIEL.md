# Änderungen — 06.11.2026 (Daniel)

## 1. Alles schwarz-weiss
- `client/src/index.css`: Palette ist jetzt reines Grau/Schwarz/Weiss.
  Fehler sind ein invertierter weisser Block (schwarze Schrift), Warnungen
  haben einen gestrichelten Rahmen — keine Farbe mehr als Signal.
  Vorher farbig: Fehler-Rot (`#ff9a92`), Warn-Gelb (`#f0b64a`),
  dunkelrote/braune Hintergründe.
- `diagnose.html`: Grün/Gelb/Rot/Blau entfernt, gleiche Logik wie oben.
- `client/public/icons.svg`: Lila (`#aa3bff`) → Grau.
- `client/public/favicon.svg`, `abi-flasher-logo.svg`: letzte leicht
  getönte Graus → reines Grau.
- `client/src/assets/hero.png`: in Graustufen umgewandelt.
- Sicherheitsnetz im CSS: `img { filter: grayscale(1); }` — kein Bild
  kann mehr Farbe ins UI bringen.
- Gelöscht: `client/src/assets/react.svg`, `vite.svg` (ungenutzte
  Template-Dateien mit Farbe, nirgends eingebunden).
- Geprüft: `client/dist` nach dem Build enthält nur Grau/Schwarz/Weiss.

## 2. ABI ADMIN — Key-Generator mit Admin Key
- `#admin` ist jetzt ein 2-Schritte-Flow:
  1. **Admin-Login** mit dem Admin Key (= Master Key aus
     `.secrets/abi-keymaster.txt`). Wird nur im Speicher der Seite
     gehalten, nie gespeichert, nie gesendet, nach Reload weg.
  2. **Key-Generator**: Credits pro Key (1–1000), Gültigkeit in Tagen
     (0 = unbegrenzt), Anzahl (1–25). Kopieren einzeln/alle, Download
     als `.txt`, „Diesen Key verwenden“ meldet direkt mit dem Key an.
- Keys sind jetzt **ABI1 v2** (15-Byte-Payload): die Credits stehen in
  der signierten Payload, niemand kann sie nachträglich erhöhen.
  Alte v1-Keys funktionieren weiter, haben aber kein Guthaben
  („Legacy-Key, ohne Credits“) — bitte neu ausstellen.

## 3. 1 Credit = 1 Flash
- Der Credit wird vom Server verbraucht, wenn das Firmware-Bild für
  einen Flash geladen wird (`GET /api/studio/image/:id?mode=flash`) —
  atomar, vor dem Senden der Bytes. Auch ein danach abgebrochener
  Flash verbraucht den Credit (Lieferung = Lieferung).
- „Bild prüfen“ (`?mode=probe`) verbraucht **keinen** Credit, braucht
  aber mindestens 1 übrigen Credit, weil das volle Bild geladen wird.
- Stand: `GET /api/studio/credits`. Zähler serverseitig in
  `server/credits.js`: mit `DATABASE_URL` in Postgres
  (`flasher_studio_credits`, siehe `server/schema.sql`), ohne Datenbank
  in der Datei `server/data/studio-credits.json` (nur ein Server).
  Ohne Server zählt das Gerät lokal mit und zeigt „nur auf diesem
  Gerät“ — das ist eine Anzeige, kein Schutz (per Site-Daten löschbar).
- Das Studio zeigt das Guthaben im Access-Panel und über der
  Firmware-Liste, blockiert den Flash bei 0 Credits, und das Key-Gate
  weist einen leeren Key schon beim Anmelden ab.
- Gefixt nebenbei: Als Operator (nur Admin Key, kein User-Key) ist der
  Flash-Button jetzt gesperrt statt still zu scheitern — vorher hat
  der Bild-Download mit „Kein Key gespeichert“ abgebrochen, weil kein
  Key hinterlegt war.
- Gefixt nebenbei: Verzeichnisrechte im ZIP (`firmware_storage`,
  `emulator_core/captures`) hatten kein Execute-Bit — Tests konnten
  die Firmware-Dateien nicht lesen.

## Geprüft
- `npm run lint --prefix client`: 0 Warnungen, 0 Fehler.
- `npm run build --prefix client`: erfolgreich.
- Tests: 53/53 grün (`access-key`, `key-credits` neu, `ble`,
  `identity`, `ui`, `enc2`, `flash-wire`). Neu: v2-Key mit Credits,
  Credit-Grenzen 1..1000, exakt 3 Flashes bei 3 Credits, der 4. wird
  abgelehnt, gleichzeitige Zugriffe gewinnen den letzten Credit nur
  einmal.
- Server-Smoke-Test: `/api/health` ok, `/api/studio/image` und
  `/api/studio/credits` ohne/ge fälschten Key → 401.
- Nicht grün, aber schon vorher und ausserhalb dieser Änderung:
  `containment` (3 Tests brauchen `DATABASE_URL`, hier nicht gesetzt),
  `durable` + `studio-key` (brauchen `.secrets/`-Dateien, die nie in
  einer ZIP sein dürfen).

## Deployen
Wie bisher: `npm ci && npm ci --prefix client`, dann Vercel-Deploy.
Für den Postgres-Zähler einmal `server/schema.sql` anwenden (neue
Tabelle `flasher_studio_credits`). Ohne Datenbank läuft der Zähler
über die Datei — auf Vercel mit mehreren Instanzen bitte die
Datenbank nehmen.
