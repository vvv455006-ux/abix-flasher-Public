# Segway Ninebot G3 / F3 — Fehleranalyse: falsche F3-Erkennung und BLE-Flash-Abbruch

Stand: 6. November 2026. Untersuchtes Objekt: `abix-flasher-export.zip` (Projekt „Abi x OsmanAbi — Ninebot G3 Max & F3 Custom Display BLE Flasher / StarCFW G3 Studio“, Export vom 5.11.2026).

---

## 1. Ergebnis in Kurzform

Zwei Befunde, beide belegt, beide unabhängig voneinander:

**A. Der Flash kann mit diesem Tool auf einem G3 grundsätzlich nicht durchlaufen.** Nicht wegen Signalqualität, Akku oder Kabel, sondern weil das Tool ein Frame-Format sendet, das ein x3-Fahrzeug (G3/F3) nicht als Frame erkennt, an die falsche Platine adressiert, unverschlüsselt sendet, obwohl das Gerät Encryption2 verlangt, und den IAP-Ablauf falsch aufbaut (Länge 0, keine Prüfsumme, kein Reset). Die Bytes erreichen das Dashboard, werden dort aber verworfen. Was im Tool als „Bootloader acknowledgment timeout“ erscheint, ist in Wahrheit „das Gerät hat nie ein gültiges Frame gesehen“.

**B. Die F3-Erkennung ist kein Messfehler, sondern ein Default.** An vier Stellen im Code wird „ich weiß es nicht“ zu „F3“: ein doppelter Anzeigename im Firmware-Katalog, ein `startsWith("g3")`-Fallback in der Lizenz-Datenbank, eine Vorversion mit Familien-Heuristik (im Projekt-Audit dokumentiert), und — strukturell — die Tatsache, dass die Modellkennung nie tatsächlich gelesen wird, weil die Lesebefehle ins Leere gehen. Ein Gerät, das nie identifiziert wird, fällt zwangsläufig in den Fallback.

Beides ist im Code korrigiert. Die Identität ist jetzt beweisbasiert und verweigert im Zweifel, statt zu raten. Der Flash-Ablauf entspricht dem dokumentierten IAP-Protokoll.

**Wichtige, ehrliche Grenze:** Der Export enthält keine Encryption2-Implementierung (AES-Handshake). G3 und F3 sind laut Herstellerkonfiguration `encrypt: 2`. Ohne diesen Handshake wird auch ein korrekt gebautes Frame auf echter Hardware nicht angenommen. Das ist kein Fehler, den man wegpatchen kann, ohne die Schlüsselableitung zu kennen — und Schlüssel zu raten würde das Display zerstören. Details in Abschnitt 7.

---

## 2. Was tatsächlich auf dem Draht passiert

### 2.1 Zwei Framings, die nicht austauschbar sind

| | Protocol 1 | Protocol 2 |
|---|---|---|
| Magic | `55 AA` | `5A A5` |
| Aufbau | `LEN ADDR CMD ARG PAYLOAD CK` | `LEN BT_ID TARGET_ID CMD ARG PAYLOAD CK` |
| LEN bedeutet | CMD+ARG+Payload | nur Payload |
| Gesamtlänge | `LEN + 6` | `LEN + 9` |
| Verwendet von | Ninebot One/Mini, Xiaomi M365 | **alle BLE-Varianten, alle x3 (G3, F3, GT3, ZT3)** |

Quellen: [ninebot-docs/protocol](https://github.com/etransport/ninebot-docs/wiki/protocol), [NootNooot BLE-Doku](https://nootnooot.codeberg.page/segway-ninebot-ble/board-addressing/), [Ninebot-G30-Custom DECOMPILATION.md](https://github.com/Vicy-DE/Ninebot-G30-Custom/blob/main/firmware/decompiled/DECOMPILATION.md).

Der G3 Max (HW-ID 258, serverId 10258) und der F3 (HW-ID 259, serverId 10259) sind beide `ble_protocol: 2, encrypt: 2`. Also **Protocol 2 + Encryption2**.

### 2.2 Was das Tool sendet

Original `client/src/services/codec.js`, `buildPacket`:

```js
const body = [payload.length + 2, target, 0x3e, command, register, ...payload];
return new Uint8Array([0x55, 0xaa, ...body, crc & 255, (crc >> 8) & 255]);
```

Vier Abweichungen in fünf Zeilen:

1. **Magic `55 AA`** statt `5A A5`. Ein Protocol-2-Parser synchronisiert auf `5A A5` und findet hier nie einen Frameanfang. Das Gerät antwortet nicht, weil es nichts erkennt — nicht, weil es zu langsam ist.
2. **LEN = `payload.length + 2`** (Protocol-1-Semantik). Selbst wenn die Magic stimmte: das Gerät erwartet `LEN + 9` Bytes und wartet bei einem 130-Byte-Block auf 141 statt 139 Bytes. Das Frame wird nie vollständig.
3. **Adressreihenfolge vertauscht.** Dokumentiert ist `5A A5 02 3E 20 01 10 0E 00 …` — erst `0x3E` (App/BT_ID), dann die Platine. Das Tool schreibt `target` gefolgt von `0x3e`, also `20 3E`. Frames mit falschem BT_ID werden laut Spezifikation **still verworfen**.
4. **Checksumme `sum ^ 0xffff`.** Nur korrekt, solange die Summe in 16 Bit passt. Ein maximales Frame summiert über 65 535; dann kippt die Funktion still. Die Firmware rechnet `mvn` + `uxth`, also `~sum & 0xFFFF`.

### 2.3 Falsche Platine

Das Tool adressiert hart `0x20`:

```js
buildPacket(0x20, 0x07, 0x01, [0, 0])   // "enter bootloader"
buildPacket(0x20, 0x08, 0, [...])       // block
buildPacket(0x20, 0x07, 0x02, [0, 0])   // "finalize"
```

`0x20` ist die Adresse des **ESC** in der alten G30/ESx-Welt. Auf x3 gibt es keinen ESC; die Adresskarte ist: `0x01` DIS, `0x02` MCU, `0x04` BLE, `0x06/0x07` BMS, `0x09` ECU/VCU, `0x16` VCU, **`0x20` CHG (Ladegerät)**, `0x23` TFT. Quelle: [Board Addressing](https://nootnooot.codeberg.page/segway-ninebot-ble/board-addressing/) (live bestätigt an einem E125S).

Das Dashboard-Firmware-Upgrade läuft über den BLE-/Display-Baustein (`0x04` bzw. `0x23`), nicht über das Ladegerät.

### 2.4 Der IAP-Ablauf ist unvollständig

Dokumentierter Ablauf: `0x07` begin (Payload = u32 Gesamtlänge) → `0x08` Block (ARG = Blockindex, Payload = Vielfaches von 8, Standard 128) → `0x09` verify (u32 = `~sum32` über das ganze Image) → `0x0A` reset (keine Antwort) → Antworten kommen als `0x0B` mit ARG = Ergebniscode.

Was das Tool macht:

| Schritt | Dokumentiert | Tool |
|---|---|---|
| begin | `0x07`, u32 Länge | `0x07`, `[0, 0]` → Länge 0 |
| Block | `0x08`, ARG = Index, Daten | `0x08`, Index in den ersten zwei Payload-Bytes, kein Padding auf 8 |
| verify | `0x09`, `~sum32` | fehlt — stattdessen ein zweites `0x07` mit ARG `0x02` |
| reset | `0x0A`, 3× | fehlt |
| Antwort | `0x0B`, ARG = Code | wird als Timeout behandelt |

Die Ergebniscodes werden nirgends ausgewertet. `0x06` (BUSY) bedeutet „Flash wird gerade geschrieben, gleichen Index nochmal senden“ — das Tool bricht stattdessen ab. `0x07` (FORM) bedeutet „Bild abgelehnt“ (Länge kein Vielfaches von 8, oder Modell-/Downgrade-Schutz) — erscheint als Timeout, also als ob der Funk spinnt. Genau diese Verwechslung ist der Grund, warum „neu verbinden, nochmal versuchen“ nie hilft.

### 2.5 Falsche GATT-UUIDs

```js
export const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
```

Das ist die **Stock-Nordic-UART**. Aktuelle Segway-Ninebot-Hardware nutzt `6e400001-0000-0000-006e-696e65626f74` (Suffix = `\0ninebot`), und dort ist die Notify-Charakteristik **`0004`**, nicht `0003` (`0003` ist ein zweiter Schreibkanal). Quelle: [BLE Transport](https://nootnooot.codeberg.page/segway-ninebot-ble/transport).

Mit dem Stock-Filter findet das Tool das Gerät entweder gar nicht, oder es verbindet und bekommt nie eine Antwort. Beides sieht im UI gleich aus.

### 2.6 Transport-Details, die Abbrüche erzeugen

- Harter 20-Byte-Chunk, kein MTU-Bewusstsein. Ein 130-Byte-Block = 7 GATT-Writes.
- `if (this.rx.properties.write)` — wenn die Charakteristik nur `writeWithoutResponse` anbietet, wirft das Tool sofort „Qualified reliable GATT writes are unavailable“. Viele NUS-Varianten sind genau so.
- `timeoutMs = 1500` fest, und der Timer läuft **parallel** zum Schreibvorgang. Bestätigte Writes kosten 30–80 ms pro Chunk; 7 Chunks plus Stack-Jitter liegen regelmäßig über 1,5 s → falscher Timeout → Retry → „GATT operation already in progress“ → Abbruch. Genau die Kaskade, die du siehst.
- Keine Serialisierung der GATT-Operationen. Web Bluetooth stellt Operationen nicht in eine Warteschlange.
- Ein Disconnect nach dem Schreiben wird als Fehler behandelt. Das BLE-Modul rebootet nach dem Flash aber hart — der Disconnect ist normal.

---

## 3. Warum dein G3 als F3 erscheint

Vier Ursachen, absteigend nach Beweislage.

### 3.1 Doppelter Anzeigename im Katalog (belegt, im Code sichtbar)

`server/firmware_service.js`, Original:

```js
const DEFINITIONS = Object.freeze({
  g3_blackwave: { name: "Blackwave", model: "g3" },
  g3_smoke:     { name: "Stone Island", model: "g3" },
  f3_smoke:     { name: "Stone Island", model: "f3" },
  f3_display:   { name: "Under Armour", model: "f3" },
});
```

`g3_smoke` und `f3_smoke` heißen beide **„Stone Island“**. `/api/firmwares` liefert damit zwei Einträge mit identischem Namen. Die Kundenansicht in `client/src/App.jsx` zeigt ausschließlich `name`:

```jsx
{catalog.find((f) => f.id === license.fileId)?.name || license.fileId}
```

Ein G3-Kunde sieht „Stone Island“ — und daneben gibt es einen zweiten „Stone Island“-Eintrag, der F3-Firmware ist. Die `info.json`-Dateien enthielten die korrekte Unterscheidung längst (`"Stone Island g3"` / `"Stone Island f3"`), sie wurde nur nie gelesen.

Jetzt: Der Katalog liest `displayName`, erzwingt den Modell-Suffix und **wirft beim Start**, wenn zwei Einträge kollidieren. Verifiziert:

```
g3_blackwave | g3 | Blackwave g3      | g3_BLE
g3_smoke     | g3 | Stone Island g3   | g3_BLE
f3_smoke     | f3 | Stone Island f3   | f3_BLE
f3_display   | f3 | Under armour f3   | f3_BLE
```

### 3.2 `startsWith("g3")` als Modell-Zuordnung (belegt)

`server/db.js`, Original, an zwei Stellen:

```js
model: file.startsWith("g3") ? "g3" : "f3",
```

Alles, was nicht mit kleingeschriebenem `g3` beginnt, wird **F3**. Ein Legacy-Schlüssel mit `G3_SMOKE`, mit Leerzeichen, mit anderem Trennzeichen oder ein umbenanntes Bundle landet als F3-Lizenz in der Datenbank. Diese Lizenz schaltet dann F3-Firmware frei.

Jetzt: `modelForFirmwareId()` aus der Registry. Unbekannte ID → `null` → Fehler, kein Default. Bei der Legacy-Migration werden unbekannte IDs nicht mehr still auf `g3_smoke` gebogen, sondern als `rejected` gemeldet, damit sie von Hand geprüft werden.

### 3.3 Familien-Heuristik in der Vorversion (belegt durch das Projekt-Audit)

`AUDIT.md`, Befund B4, über die vorherige Implementierung:

> `identifyModel` intentionally groups G30/G2/MAX with G3 and F2/F40 with F3, and defaults unknown devices to G. Frontend preflight compares only initial g/f. […] Manifest `enforceModel`, `compatible` and type fields are ignored.

Das ist exakt der Fehlermechanismus: Familien-Präfix plus Default. Ein Gerät, dessen Name nicht in die erwartete Form passt, fällt in den Default-Zweig. Der Export enthält eine teilweise reparierte Fassung, in der nur noch `g3`/`f3` exakt akzeptiert werden — aber `identifyModel({ rawModelCode })` nimmt weiterhin einen **beliebigen String** und etikettiert ihn mit `confidence: "exact-register"`, also „registergenau gelesen“, obwohl niemand ein Register gelesen hat.

### 3.4 Die strukturelle Ursache: es wird nie gelesen

Alle drei Punkte oben sind nur relevant, weil die eigentliche Modellkennung auf echter Hardware nie stattfindet. Die Lesebefehle gehen an `0x20` (Ladegerät) mit Protocol-1-Magic, also ins Leere. Was übrig bleibt, ist der Fallback — und der hieß bisher F3.

Deshalb ist die Reihenfolge der Reparatur wichtig: **erst die Identität beweisbar machen, dann den Flash reparieren.** Sonst schreibt man irgendwann ein korrekt übertragenes F3-Image auf ein G3-Dashboard.

### 3.5 Bekannter Präzedenzfall (belegt, aber anderes Modell)

r/NinebotMAX: ein **F3 wurde nach einer Seriennummern-Änderung als Max G3 erkannt**, danach `Error(7) Data Format Error` beim VCU-/MCU-Flash. Das zeigt: Modellerkennung hängt in dieser Fahrzeugfamilie an Seriennummer/Beacon, nicht an einer kryptografisch gesicherten Kennung — und eine falsche Zuordnung blockiert danach echte Flash-Vorgänge. Es bestätigt den Mechanismus, nicht deinen konkreten Fall.

---

## 4. Bestätigt vs. Hypothese

| Aussage | Status | Grundlage |
|---|---|---|
| G3/F3 nutzen Protocol 2 (`5A A5`), nicht `55 AA` | **bestätigt** | Herstellerkonfiguration, `ble_protocol: 2` für HW 258/259 |
| G3/F3 verlangen Encryption2 (`encrypt: 2`) | **bestätigt** | dieselbe Konfiguration |
| `0x20` ist auf x3 das Ladegerät, nicht der ESC | **bestätigt** | Board-Addressing-Tabelle, live bestätigt |
| Der IAP-Ablauf ist `0x07/0x08/0x09/0x0A` mit `0x0B`-Antwort | **bestätigt** | ninebot-docs + dekompilierte Firmware |
| Das Tool sendet ein nicht parsebares Frame | **bestätigt** | Originalcode + Protokolldefinition, nachrechenbar |
| Deshalb kann der Flash nie bestätigt werden | **bestätigt** | folgt zwingend aus dem Frame-Format |
| Doppelter Katalogname „Stone Island“ | **bestätigt** | Code + `info.json` + Katalogausgabe |
| `startsWith("g3")` erzeugt F3-Lizenzen | **bestätigt** | Code |
| Vorversion hatte Familien-Heuristik mit Default | **bestätigt** (für den im Audit genannten Commit) | `AUDIT.md` B4 |
| Dein Gerät hat tatsächlich HW-ID 258 im Advertisement | **unbestätigt** | nicht auf dem Draht verifiziert; `diagnose.html` klärt es |
| Dein Abort passiert bei 0 % (nicht mitten im Transfer) | **unbestätigt** | hängt vom Log ab; Entscheidungstabelle in §6 |
| Ein G3-BLE-Image lässt sich auf ein F3-Display flashen | **unbestätigt / unwahrscheinlich** | kein dokumentierter Fall gefunden; Tools und Manifeste sperren es |

---

## 5. Was im Code geändert wurde

| Datei | Änderung |
|---|---|
| `client/src/services/ninebotProtocol.js` | **neu.** Einzige Implementierung des Framings: Protocol 2 und Legacy, korrekte Länge, `BT_ID` vor `TARGET_ID`, `~sum16`, Board- und IAP-Konstanten, Fehlercodetabelle, Parser mit Resync. |
| `client/src/services/ninebotModel.js` | **neu.** Beweisbasierte Identität: HW-IDs 258/259, Serienpräfixe `1CG`/`1EF`, VCU-Banner `xxG3`/`xxF3`. `identifyDevice()` verlangt zwei übereinstimmende Quellen für `verified`, erkennt Widersprüche als `conflict`, kennt fremde x3-Modelle beim Namen. `requireExactModel()` ist das harte Gate vor jedem Transfer. |
| `client/src/services/codec.js` | Nur noch Adapter. `buildPacket` baut jetzt Protocol 2; `FrameParser` kommt aus dem Protokollmodul. |
| `client/src/services/ninebotBleService.js` | Ninebot-UUID zuerst, NUS als Fallback, Notify `0004`/`0003`; GATT-Mutex für alle Operationen; Schreibmodus wird ausgehandelt (mit/ohne Antwort); Chunk-Größe konfigurierbar; Timeout aus der Chunk-Anzahl berechnet statt fix 1500 ms; Stale-Notification-Drain; Echo-Erkennung; `readAdvertisement()` und `diagnose()` (nur lesend). |
| `client/src/services/flashEngine.js` | Echter IAP-Ablauf: begin mit u32-Länge, Block mit Index in ARG und Padding auf 8, verify mit `~sum32`, reset 3× ohne Antwort. Fehlercodes werden dekodiert (`IAP_FORM`, `IAP_BUSY`, `IAP_CRC` …), BUSY wiederholt den gleichen Index, Disconnect wird nie als verlorene Antwort wiederholt. |
| `client/src/services/simulator.js` | An den neuen Profil-Vertrag angepasst; ACK-Form `0x0B`/ARG=Code, Fehler klassifiziert. |
| `server/firmware_service.js` | Katalog liest `displayName`, erzwingt Modell-Suffix, prüft Eindeutigkeit, prüft `enforceModel`/`compatible`/`type` aus dem Manifest. |
| `server/db.js` | Modell über die Registry statt `startsWith`. Legacy-Import verweigert unbekannte IDs statt sie auf G3 zu biegen. |
| `server/app.js` | Lizenz-/Firmware-Modell wird gegen die Registry geprüft; inkonsistente Zeilen liefern 409 statt Firmware. |

---

## 6. Verifikation

`npm run test:unit` → **30 Tests, 30 grün**, davon 20 neu in `tests/identity.test.mjs`.

Abgedeckt:
- Frame-Magic, LEN-Semantik, Gesamtlänge, Adressreihenfolge (`5A A5 02 3E 20 …`).
- Checksumme als `~sum16`, inklusive eines Vektors, dessen Summe 16 Bit überschreitet (die alte Formel liefert dort ein anderes Ergebnis — der Test schlägt mit der alten Implementierung fehl).
- Parser über drei fragmentierte Notifications; Resync nach kaputter Checksumme.
- Serienpräfix, VCU-Banner, Ablehnung des geteilten MCU-Banners, Ablehnung von ZT3.
- Ein BLE-Name allein ergibt **nie** ein Modell.
- Eine Quelle → `provisional`; zwei übereinstimmende → `verified`; Widerspruch → `conflict` ohne Modell.
- `modelForFirmwareId`: `G3_SMOKE`, `"g3"`, `""`, `unknown_mod` → alle `null` (früher: F3).
- `requireExactModel` verweigert unknown/provisional/conflict/mismatch und nicht registrierte IDs.
- Manifest ohne `enforceModel`, mit falschem `compatible` oder falschem `type` wird abgelehnt.
- IAP-Sequenz: Länge im begin, Index in ARG, letzter Block auf 8 gepadded, `~sum32` in verify, drei Resets.
- `0x07` FORM wird als `IAP_FORM` dekodiert, nicht als Timeout.
- BUSY (`0x06`) wiederholt denselben Index.
- Disconnect wird genau einmal versucht, nicht wiederholt.
- Provisonal-Identität verhindert jeden Transfer, bevor ein Byte gesendet wird.

---

## 7. Was noch nicht gelöst ist — und warum ich es nicht rate

G3 und F3 haben `encrypt: 2`: **Encryption2**, AES-128 CTR mit CBC-MAC, Handshake mit `PRE_COMM` → `SET_PWD` → `AUTH`, wobei der Gerätename als Schlüsselmaterial eingeht. Dieser Export enthält davon **nichts** — kein Handshake, keine Schlüsselableitung, keine Chiffre.

Konsequenz, klar gesagt: Selbst mit dem jetzt korrekten Framing, der richtigen Platine und dem richtigen IAP-Ablauf wird ein echtes G3-Gerät die Frames verwerfen, solange der Enc2-Handshake fehlt. Ich könnte eine Chiffre „irgendwie“ einbauen — das würde bedeuten, Schlüssel zu raten, und ein halb entschlüsseltes IAP-Schreibkommando auf ein laufendes Display zu schicken. Das ist der schnellste Weg zu einem toten Dashboard.

Deshalb:

- Die Identität ist jetzt ohne jeden Schreibzugriff klärbar (Advertisement + optionaler Read-Pfad).
- Der Flash-Pfad ist strukturell korrekt und **verweigert** ohne qualifiziertes Profil, statt mit falschen Frames zu arbeiten.
- Was fehlt, um ihn scharf zu schalten: ein Mitschnitt des Enc2-Handshakes von genau deinem Gerät (oder ein qualifiziertes Profil von jemandem, der ihn hat). Damit ist `profile.ackCode` und die Chiffre zu füllen; der Rest steht.

Wenn dein Ziel „Scooter jetzt flashen“ ist und nicht „Tool fertigbauen“: nimm ein Werkzeug, das x3-BLE und Enc2 kann (ScooterHacking Utility V4 / IAP). Das ist kein Ausweichen, das ist der aktuell einzige Weg, der den Handshake hat.

---

## 8. Handlungsanleitung für dein Gerät

### Schritt 0 — Nichts flashen, solange die Identität nicht belegt ist

Kein G3-Image auf ein F3-Display und umgekehrt. Kein „ich korrigiere die Seriennummer, damit die Erkennung passt“ — genau das hat im dokumentierten Präzedenzfall den Flash dauerhaft blockiert (`Error(7)`).

### Schritt 1 — Identität messen, nicht raten

`diagnose.html` im Projektwurzelverzeichnis über **localhost** öffnen (Web Bluetooth braucht einen sicheren Kontext; `file://` genügt nicht):

```bash
python -m http.server 8000
# dann: http://localhost:8000/diagnose.html
```

Die Seite schreibt **nichts** auf das Gerät. Sie listet:

- Gerätename
- alle GATT-Services und Charakteristiken mit Properties (zeigt sofort, ob neunbot- oder NUS-Profil, und ob `write` oder `writeWithoutResponse`)
- 5 s Advertisement-Daten, inklusive Hersteller-ID und Rohbytes
- das Identitätsurteil inklusive Begründung

### Schritt 2 — Zweite Quelle holen

Für `verified` brauchst du zwei übereinstimmende Quellen. Die belastbaren:

| Quelle | Wert für G3 | Wert für F3 |
|---|---|---|
| Seriennummer, erste 3 Zeichen | `1CG` | `1EF` |
| VCU-Banner (Flash @ `0x400`) | `SCOOTER_VCU_xxG3` | `SCOOTER_VCU_xxF3` |
| Herstellerkonfiguration HW-ID | `258` | `259` |

Das **MCU-Banner `SCOOTER_MCU_0001` ist bei allen Modellen identisch** und taugt nicht als Beweis — der Code lehnt es deshalb ausdrücklich ab. Der F3 nutzt außerdem andere Motorcontroller-Hardware als G3/GT3/ZT3, was das Banner ebenfalls nicht zeigt.

Wenn du zusätzlich eine App bemühst: Modell **und** BLE-/VCU-/MCU-Versionen notieren. Zwei unabhängige Anzeigen, die dasselbe sagen, sind eine zweite Quelle.

### Schritt 3 — Firmware auswählen

Nur IDs, die in der Registry diesem Modell zugeordnet sind:

- G3: `g3_blackwave`, `g3_smoke`
- F3: `f3_smoke`, `f3_display`

Die API liefert jetzt modellqualifizierte Namen (`Stone Island g3` / `Stone Island f3`) und `compatible: ["g3_BLE"]` bzw. `["f3_BLE"]`. Wenn dort etwas anderes steht: nicht flashen.

### Schritt 4 — Flashen

Mit einem Werkzeug, das Protocol 2 + Enc2 spricht. Vorher:

1. Akku ≥ 30 %, stehend, nicht am Ladegerät.
2. Telefon entsperrt, Tab im Vordergrund, Bildschirmsperre aus (Wake Lock wird gehalten, aber ein Hintergrund-Tab verliert ihn).
3. Bluetooth-Kopplung des Fahrzeugs in den Systemeinstellungen **entfernen**, falls eine besteht — Bonding-Reste (alte CCCD-Zustände, Echo-Verhalten) sind eine belegte Fehlerquelle.
4. Nach dem Transfer: Verbindung fällt weg = normal, das Modul rebootet. Nicht als Fehler werten, aber auch nicht als Erfolg — erst nach dem Reconnect die Version erneut lesen.

### Schritt 5 — Wenn es schiefgeht

| Symptom | Wahrscheinliche Ursache | Vorgehen |
|---|---|---|
| Abbruch bei 0 %, „keine Antwort“ | Frame/Adresse/Enc2 — nichts ist angekommen | kein Retry-Loop; Profil prüfen, nicht den Akku |
| Abbruch mitten im Transfer | Funk/Timeout/BUSY | Abstand, Vordergrund, Retry mit gleichem Index |
| `Data Format Error` / `FORM` | Bild abgelehnt: Länge oder Modell-/Downgrade-Schutz | anderes Image, **nicht** weiterprobieren |
| Display schwarz, Alarm | BLE-Image beschädigt (auch bei eigenem Update möglich, siehe G3 0.4.4) | Reboot-Versuch, sonst Service |
| Alles tot | — | x3-Recovery ist **ST-LINK/SWD am VCU** (Debug-Pads, vorher 128 KB Full-Dump), nicht BLE |

Reboot-Versuch bei x3: **Bremse 5×, dann Powertaste.**

---

## 9. Quellen

**Protokoll / Register**
- [ninebot-docs — protocol](https://github.com/etransport/ninebot-docs/wiki/protocol)
- [ninebot-docs — ES2ESC Register](https://github.com/etransport/ninebot-docs/wiki/ES2ESC)
- [Ninebot-G30-Custom — DECOMPILATION.md](https://github.com/Vicy-DE/Ninebot-G30-Custom/blob/main/firmware/decompiled/DECOMPILATION.md) (Checksumme `mvn`/`uxth`, Framelänge, IAP-Opcodes)
- [Ninebot-G30-Custom — protocol.md](https://github.com/Vicy-DE/Ninebot-G30-Custom/blob/main/docs/protocol.md)
- [NootNooot — BLE Transport](https://nootnooot.codeberg.page/segway-ninebot-ble/transport) (UUIDs, Notify `0004`, Fragmentierung)
- [NootNooot — Board Addressing](https://nootnooot.codeberg.page/segway-ninebot-ble/board-addressing/) (Adresskarte, HW-IDs 258/259, `ble_protocol`/`encrypt`)
- [NootNooot — Devices](https://nootnooot.codeberg.page/segway-ninebot-ble/devices/)

**x3-Hardware / Modellkennung**
- [segMod — Architecture](https://github.com/MacintoshKeyboardHacking/segMod/wiki/Architecture) (BLE-Modul = Display, UART zum VCU)
- [segMod — Teardown-Diskussion](https://github.com/MacintoshKeyboardHacking/segMod/discussions/8) (NB-BT100)
- [x3utils — device_spec.dart](https://raw.githubusercontent.com/ztakis/x3utils/main/x3utils_flutter/lib/engine/device_spec.dart) (Serienpräfixe `1CG`/`1EF`, VCU-Banner, Allow-List)
- [x3utils — Max G3 / F3 Wiki](https://github.com/ztakis/x3utils/wiki/21.-Max-G3-F3-F3-Pro)
- [ScooterHacking — ZIP-v3-Format](https://github.com/scooterhacking/wiki/blob/main/pages/zip3.txt) (`model` + `enforceModel`)
- [FCC — NB-BT100 Modul](https://fcc.report/FCC-ID/2BD7T-IF0001/7036062.pdf)
- [r/NinebotMAX — F3 als Max G3 erkannt](https://www.reddit.com/r/NinebotMAX/comments/1tu23j4/ninebot_f3_detected_as_max_g3_after_shu_flashing/)

**Web Bluetooth**
- [Chrome — Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth)
- [whatwg/bluetooth #188](https://github.com/whatwg/bluetooth/issues/188) (keine eingebaute GATT-Queue)
- [whatwg/bluetooth #383](https://github.com/whatwg/bluetooth/issues/383) (kein MTU-API)
- [MDN — writeValueWithResponse](https://developer.mozilla.org/en-US/docs/Web/API/BluetoothRemoteGATTCharacteristic/writeValueWithResponse)
- [Chromium — BluetoothError.cpp](https://chromium.googlesource.com/chromium/src/+/b120052928a9adbea3433c206ad659a6197c8600/third_party/WebKit/Source/modules/bluetooth/BluetoothError.cpp)

**Projektintern**
- `AUDIT.md` (Befund B4, K6, K7), `REMEDIATION_STATUS.md` (Phase 3)

---

## 10. Offene Punkte, die nur du schließen kannst

1. **Enc2-Mitschnitt** deines Geräts (Handshake + ein Block). Damit lässt sich der Flash-Pfad scharf schalten, ohne zu raten.
2. **Seriennummer + VCU-Banner** auslesen und hier festhalten — dann ist die Modellfrage endgültig beantwortet.
3. **Log des Abbruchs**: bei wie viel Prozent, mit welcher Meldung. Die Tabelle in §8 Schritt 5 ordnet es zu.
