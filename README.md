# packetbar – Paketverfolgung in der GNOME-Top-Bar

> [!WARNING]
> **Privates Hobbyprojekt – nicht gepflegt / unmaintained.**
> Dieses Repository ist für meinen eigenen Gebrauch gedacht und wird nur aus Bequemlichkeit öffentlich bereitgestellt.
>
> * **Keine Unterstützung:** Issues und Pull Requests werden nicht bearbeitet, Feature-Wünsche nicht umgesetzt. Bitte keine Issues eröffnen.
> * **Keine Garantie:** Bereitstellung „wie besehen“, ohne jede Gewährleistung und Haftung. Nutzung auf eigenes Risiko.
> * **Eigene Umgebung:** Entwickelt und getestet nur auf meinen eigenen Ubuntu-Rechnern (24.04 / 26.04, GNOME 46–50). Auf anderen Systemen kann es fehlschlagen.
> * **Zugangsdaten & Netzwerk:** Die Extension läuft mit den Rechten deiner GNOME-Sitzung. API-Keys der Status-Anbieter (DHL, 17TRACK) werden im GNOME-Schlüsselbund (libsecret) gespeichert – verschlüsselt, solange du abgemeldet bist; während der Sitzung können Programme deines Benutzers sie lesen. Die von dir eingetragenen Sendungsnummern werden regelmäßig an die Tracking-API des jeweiligen Versanddienstleisters übertragen (DHL: `api-eu.dhl.com`, UPS/DPD/GLS über 17TRACK: `api.17track.net`). Für die Versionsprüfung wird regelmäßig die `metadata.json` von `raw.githubusercontent.com` abgerufen (abschaltbar im Reiter *Updates*); die Installation per `curl … | bash` führt das geladene Skript direkt aus. **Lies den Code, bevor du ihn installierst.**
> * **Keine Updates zugesichert:** Es kann jederzeit ohne Ankündigung Änderungen, Brüche oder die Löschung des Repos geben. Gern selbst forken und anpassen.
>
> *Private hobby project, unmaintained, provided as-is. No support, no issues, no warranty. Fork it if you like.*

> **Zeigt direkt im GNOME-Panel, welche Pakete gerade zu dir unterwegs sind – DHL per API, UPS, DPD und GLS über 17TRACK.**

---

## Funktionen

* **Panel:** Paket-Symbol mit der Anzahl der Sendungen, die noch unterwegs sind. Bei einem Zustellproblem färbt sich das Symbol rot.
* **Popup im Card-Look:** Pro Sendung eine Karte mit Bezeichnung, Versender, Status, letztem Ereignis samt Ort und Zeit und der voraussichtlichen Zustellung. Ein Klick auf die Karte öffnet die Sendungsverfolgung des Versenders.
* **Versender-Seite:** Je Versender eine aufklappbare Zeile mit seiner Konfiguration (bei DHL der API-Key im Schlüsselbund, bei den anderen Link und Nummernformat). Die Zeilen kommen aus der Versender-Datenbank und ändern sich mit ihr, ohne Neuanmeldung.
* **Einstellungen:** Die Sendungen sind nach Versender gruppiert und aufklappbar (wie die Geräte in snmpbar), mit Anzahl, Status-Zusammenfassung und einem Knopf zum Entfernen zugestellter Sendungen.
* **DHL per API:** Der Status wird über die [DHL Shipment Tracking API (Unified)](https://developer.dhl.com/api-reference/shipment-tracking) abgefragt.
* **Status-Quelle je Versender:** DHL ist über die DHL-API *und* über 17TRACK abfragbar. Auf der Seite **Versender** stellst du je Versender „Automatisch“ (Standard), nur DHL oder nur 17TRACK ein. „Automatisch“ nimmt den ersten Anbieter mit gültigem Key und springt auf den nächsten, wenn ein Key fehlt oder abgelehnt wird – etwa solange der DHL-Key noch nicht freigeschaltet ist.
* **UPS, DPD, GLS über 17TRACK:** Ein einziger Key beim Tracking-Dienst [17TRACK](https://api.17track.net/) deckt diese Versender ab. Kostenlos sind 100 neu registrierte Sendungen pro Monat, Statusabfragen kosten laut [17TRACK](https://help.17track.net/hc/en-us/articles/37575160271001-Quota-Deduction-Standards-and-Rules) kein Kontingent. Die Sendungsnummern gehen dabei an 17TRACK.
* **Amazon:** Kann eingetragen werden, hat aber keine Status-Abfrage; die Karte öffnet die Bestellübersicht im Browser.
* **Versender-Datenbank:** Namen und Links der Versender stehen als JSON im Repository und werden automatisch nachgeladen – ohne Ab- und Anmelden (siehe unten).
* **Reiter „Allgemein“:** Position im Panel, Standardintervall, Ausblenden zugestellter Sendungen und die Benachrichtigungen.
* **Benachrichtigungen:** Einstellbar „Sendung wird heute zugestellt“ (sobald der Versender „In Zustellung“ meldet oder die Zustellung für heute erwartet wird) und „Sendung kommt in Kürze“ (wenn der Versender ein Zustellfenster mit Uhrzeit liefert; bei DPD über 17TRACK ist offen, ob das ankommt). Jede Meldung kommt je Sendung höchstens einmal pro Tag.
* **Abfrageintervall je Versender:** Auf der Seite **Versender** stellst du je Versender ein, wie oft abgefragt wird (15, 30 Minuten, 1, 2, 3 oder 4 Stunden). Ohne eigene Einstellung gilt das Standardintervall der Seite **Sendungen**.
* **Schonend zur API:** Das Standardlimit von DHL liegt bei 250 Anfragen pro Tag und einer pro Sekunde. packetbar fragt nur alle 15–240 Minuten ab (Standard: 60), wartet zwischen zwei Anfragen, fragt zugestellte Sendungen nie wieder ab, führt einen Tageszähler und pausiert bei einem `429`-Fehler eine Stunde.
* **Crashsicherer Schlüsselbund:** Der API-Key liegt im GNOME-Schlüsselbund (libsecret), nie in dconf. Im Shell-Prozess wird er ausschließlich ohne Entsperr-Dialog gelesen. Ist der Schlüsselbund noch gesperrt, läuft die Extension normal weiter, zeigt einen Hinweis und versucht es jede Minute erneut, bis er entsperrt ist.

> **Hinweis:** Die DHL-API liefert den Status nur zu einer Sendungsnummer, die du ihr gibst. Welche Pakete an dich unterwegs sind, kann sie nicht ermitteln. Die Sendungsnummern trägst du deshalb selbst in den Einstellungen ein.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/packetbar/main/install.sh | bash
```

Oder aus einem Klon: `./install.sh`. Danach unter Wayland einmal ab- und wieder anmelden.

| Aktion | Befehl |
| :--- | :--- |
| Installieren / aktualisieren | `./install.sh` bzw. `./update.sh` |
| Rückstandslos deinstallieren (Extension, Einstellungen, Schlüsselbund-Einträge) | `./uninstall.sh` |
| Einstellungen öffnen | `gnome-extensions prefs packetbar@johnlose.de` |

Voraussetzungen: GNOME Shell 46–50, `libglib2.0-bin` (`glib-compile-schemas`) und `gir1.2-secret-1` (libsecret).

## Einrichtung von DHL

1. Auf [developer.dhl.com](https://developer.dhl.com/) ein kostenloses Konto anlegen, eine App erstellen und die API **Shipment Tracking – Unified** hinzufügen.
2. In den Einstellungen von packetbar auf der Seite **Versender** die Zeile **DHL** aufklappen und den API-Key (in den App-Details als *Consumer Key*) eintragen und mit dem Haken bestätigen. Er wird im Schlüsselbund gespeichert. Neu erstellte Keys können laut DHL bis zu 24 Stunden brauchen, bis sie aktiv sind – bis dahin zeigt packetbar einen Auth-Hinweis.
3. Auf der Seite **Sendungen** die DHL-Sendungsnummer eintragen.

## Einrichtung von 17TRACK (UPS, DPD, GLS und optional DHL)

1. Ein Konto bei [17track.net](https://api.17track.net/) anlegen und in den API-Einstellungen den Security Key erzeugen.
2. In packetbar auf der Seite **Versender** bei UPS, DPD, GLS oder DHL den Key eintragen und bestätigen (gilt für alle, Ablage im Schlüsselbund).
3. Sendungsnummer auf der Seite **Sendungen** eintragen. Beim ersten Abruf wird sie einmalig bei 17TRACK registriert (1 Kontingent), erste Daten liegen laut 17TRACK nach etwa einer Minute vor.

> Die Anbindung ist nach der Dokumentation umgesetzt, aber noch nicht gegen die echte API getestet. Feldnamen der Antwort können abweichen; fehlende Felder werden toleriert.

## Aufbau

```
linux/
├── extension.js          Abruf-Zyklus, Timer, Netzwerk-/Standby-Überwachung, Tageslimit
├── prefs.js              Einstellungen (Libadwaita)
├── stylesheet.css        Card-Design
├── metadata.json
├── schemas/              GSettings-Schema
├── icons/                Eigenes Paket-Symbol (Würfel)
├── data/shippers.json    Versender-Datenbank (mitgeliefert, wird per Update nachgeladen)
├── src/
    ├── indicator.js      Panel-Button und Popup mit den Karten
    ├── dhlClient.js      DHL Shipment Tracking API
    ├── track17Client.js  17TRACK Tracking API (UPS, DPD, GLS)
    ├── shippers.js       Versender-Registry und Prüfung der Datenbank (reine Logik)
    ├── shipperDb.js      Datenbank laden, herunterladen, speichern
    ├── parcelUtil.js     Sendungsliste, Normalisierung der DHL- und 17TRACK-Antworten, Formatierung
    ├── secretStore.js    Schlüsselbund (mit und ohne Entsperr-Dialog)
    └── updater.js        Versionsprüfung über metadata.json auf GitHub
tests/run.mjs             Tests der reinen Logik und der mitgelieferten Datenbank
```

## Versender-Datenbank

Welche Versender es gibt, steht in [`linux/data/shippers.json`](linux/data/shippers.json):

```json
{
  "schema": 1,
  "version": 1,
  "updated": "2026-09-30",
  "shippers": [
    {
      "id": "dhl",
      "name": "DHL",
      "provider": "dhl",
      "trackUrl": "https://www.dhl.de/…/verfolgen.html?piececode={number}",
      "numberHint": "Sendungsnummer aus der Versandbestätigung"
    }
  ]
}
```

| Feld | Bedeutung |
| :--- | :--- |
| `schema` | Format der Datei. Eine Extension lehnt ein höheres Schema als das bekannte ab. |
| `version` | Wird bei jeder Änderung um 1 erhöht. Nur eine höhere Version ersetzt die installierte. |
| `id` | Kurzname, `a-z 0-9 -`, 2–20 Zeichen, eindeutig. |
| `trackUrl` | Link zur Sendungsverfolgung, muss mit `https://` beginnen. `{number}` wird durch die (URL-kodierte) Sendungsnummer ersetzt. |
| `providers` | Optional: Liste der Status-Anbieter, für die der Code einen Client mitbringt (derzeit `dhl` und `17track`), in der Reihenfolge, in der sie versucht werden. Das ältere Einzelfeld `provider` wird weiter gelesen. Ohne Angabe gibt es nur den Link. |
| `providerOptions` | Optional: feste Einstellungen je Anbieter, derzeit nur der 17TRACK-Versendercode, z. B. `{"17track": {"carrier": 7041}}` (Ganzzahl). |
| `numberHint` | Optional: Hinweis zum Nummernformat, wird beim Hinzufügen angezeigt. |
| `numberPatterns` | Optional: übliche Nummernformate, z. B. `["[0-9]{14}"]`. Beim Hinzufügen gibt es einen Hinweis, wenn die Nummer nicht passt, und bei genau einem passenden Versender wird er vorgewählt. Erlaubt sind nur Zeichenklassen, Ziffern/Buchstaben und `{n,m}` `+ * ?` – **keine** Gruppen, Alternativen (`\|`) oder Escapes, damit kein Muster die Oberfläche einfrieren kann. Mehrere Formate als Liste. |
| `minInterval`, `defaultInterval` | Optional: Mindest- und Vorgabe-Abfrageintervall in Minuten (mindestens 15). Die Vorgabe gilt, solange der Nutzer das allgemeine Intervall nie geändert hat; unter den Mindestwert geht es nie. |
| `statusMaps` | Optional, oberste Ebene: Übersetzung der Status-Werte je Anbieter in Zustand (`preTransit`, `transit`, `delivered`, `failure`, `unknown`), Text und `today` („wird heute zugestellt“, löst die Benachrichtigung aus). Einträge ergänzen oder ersetzen die eingebauten. |
| `intervals` | Optional, oberste Ebene: Auswahl für das Abfrageintervall in Minuten (15–1440). |

**So kommt ein neuer Versender dazu:** Eintrag in `shippers.json` ergänzen, `version` erhöhen, `node tests/run.mjs` ausführen, pushen. Alle Installationen holen sich die Datenbank bei der nächsten Abfrage oder über *Einstellungen → Updates → Versender-Datenbank*, **ohne Ab- und Anmelden**. Die heruntergeladene Datei liegt in `~/.local/share/packetbar/shippers.json`, übersteht Programm-Updates und wird nur von `./uninstall.sh` entfernt. Ist die mitgelieferte Datenbank neuer als die heruntergeladene, gilt die mitgelieferte.

**Was die Datenbank bewusst nicht kann:** Sie enthält nur Daten. API-Endpunkte und der Schlüsselbund-Eintrag eines Anbieters sind fest im Code hinterlegt, `provider` verweist nur darauf. Eine manipulierte Datenbank kann deshalb keine API-Keys an einen fremden Server schicken. Ungültige Einträge werden einzeln übersprungen, Links ohne `https://` abgelehnt und Downloads über 256 KB verworfen. Wird ein Versender aus der Datenbank entfernt, bleiben bereits eingetragene Sendungen erhalten.

**Was ein Ab- und Anmelden weiterhin braucht:** Neuer *Programmcode*, also etwa ein Client für die UPS-API. GNOME Shell lädt JavaScript unter Wayland nur beim Sitzungsstart neu. Die Einstellungsseite ist davon nicht betroffen, sie läuft in einem eigenen Prozess und lädt bei jedem Öffnen den aktuellen Stand.

## Entwicklung

```bash
node tests/run.mjs    # prüft die reine Logik und die mitgelieferte Versender-Datenbank
```

Einen weiteren Versender mit Status-API ergänzt man, indem man einen Client in `src/` anlegt, ihn in `extension.js` unter `_providers` einträgt (mit dem Namen des Schlüsselbund-Eintrags, der auch in `secretStore.js` und `PROVIDERS` in `shippers.js` bekannt sein muss) und in `shippers.json` per `provider` darauf verweist.
