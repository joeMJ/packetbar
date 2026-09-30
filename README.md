# packetbar – Paketverfolgung in der GNOME-Top-Bar

> [!WARNING]
> **Privates Hobbyprojekt – nicht gepflegt / unmaintained.**
> Dieses Repository ist für meinen eigenen Gebrauch gedacht und wird nur aus Bequemlichkeit öffentlich bereitgestellt.
>
> * **Keine Unterstützung:** Issues und Pull Requests werden nicht bearbeitet, Feature-Wünsche nicht umgesetzt. Bitte keine Issues eröffnen.
> * **Keine Garantie:** Bereitstellung „wie besehen“, ohne jede Gewährleistung und Haftung. Nutzung auf eigenes Risiko.
> * **Eigene Umgebung:** Entwickelt und getestet nur auf meinen eigenen Ubuntu-Rechnern (24.04 / 26.04, GNOME 46–50). Auf anderen Systemen kann es fehlschlagen.
> * **Zugangsdaten & Netzwerk:** Die Extension läuft mit den Rechten deiner GNOME-Sitzung. API-Keys der Versanddienstleister (zunächst DHL) werden im GNOME-Schlüsselbund (libsecret) gespeichert – verschlüsselt, solange du abgemeldet bist; während der Sitzung können Programme deines Benutzers sie lesen. Die von dir eingetragenen Sendungsnummern werden regelmäßig an die Tracking-API des jeweiligen Versanddienstleisters übertragen (DHL: `api-eu.dhl.com`). Für die Versionsprüfung wird regelmäßig die `metadata.json` von `raw.githubusercontent.com` abgerufen (abschaltbar im Reiter *Updates*); die Installation per `curl … | bash` führt das geladene Skript direkt aus. **Lies den Code, bevor du ihn installierst.**
> * **Keine Updates zugesichert:** Es kann jederzeit ohne Ankündigung Änderungen, Brüche oder die Löschung des Repos geben. Gern selbst forken und anpassen.
>
> *Private hobby project, unmaintained, provided as-is. No support, no issues, no warranty. Fork it if you like.*

> **Zeigt direkt im GNOME-Panel, welche Pakete gerade zu dir unterwegs sind – zunächst DHL, weitere Versender folgen.**

---

## Funktionen

* **Panel:** Paket-Symbol mit der Anzahl der Sendungen, die noch unterwegs sind. Bei einem Zustellproblem färbt sich das Symbol rot.
* **Popup im Card-Look:** Pro Sendung eine Karte mit Bezeichnung, Versender, Status, letztem Ereignis samt Ort und Zeit und der voraussichtlichen Zustellung. Ein Klick auf die Karte öffnet die Sendungsverfolgung des Versenders.
* **DHL per API:** Der Status wird über die [DHL Shipment Tracking API (Unified)](https://developer.dhl.com/api-reference/shipment-tracking) abgefragt.
* **Weitere Versender:** UPS, DPD, GLS und Amazon können eingetragen werden. Für sie gibt es (noch) keine Status-Abfrage, die Karte öffnet die Sendungsverfolgung im Browser.
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
2. In den Einstellungen von packetbar auf der Seite **DHL** den API-Key eintragen und mit dem Haken bestätigen. Er wird im Schlüsselbund gespeichert.
3. Auf der Seite **Sendungen** die DHL-Sendungsnummer eintragen.

## Aufbau

```
linux/
├── extension.js          Abruf-Zyklus, Timer, Netzwerk-/Standby-Überwachung, Tageslimit
├── prefs.js              Einstellungen (Libadwaita)
├── stylesheet.css        Card-Design
├── metadata.json
├── schemas/              GSettings-Schema
└── src/
    ├── indicator.js      Panel-Button und Popup mit den Karten
    ├── dhlClient.js      DHL Shipment Tracking API
    ├── parcelUtil.js     Versender-Register, Sendungsliste, Normalisierung, Formatierung
    ├── secretStore.js    Schlüsselbund (mit und ohne Entsperr-Dialog)
    └── updater.js        Versionsprüfung über metadata.json auf GitHub
```

Weitere Versender mit Status-API lassen sich ergänzen, indem man einen Client in `src/` anlegt, ihn in `extension.js` unter `_clients` einträgt und im Register `CARRIERS` in `parcelUtil.js` `api: true` und einen `secret`-Namen setzt.
