/**
 * prefs.js - Libadwaita / GTK4 Einstellungsdialog für packetbar (GNOME 46 - 50)
 */

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { lookupSecret, storeSecret, clearSecret } from './src/secretStore.js';
import { UpdateChecker } from './src/updater.js';
import { loadShippers, updateShippers, shipperInfo } from './src/shipperDb.js';
import {
    carrierIds, getCarrier, parseParcels, serializeParcels, makeParcel, normalizeNumber,
    validateNumber, parseCache,
} from './src/parcelUtil.js';

// Schlüsselbund-Eintrag des DHL-Keys (fest im Code, siehe extension.js)
const DHL_SECRET = 'dhl-api-key';

export default class PacketBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Versender-Datenbank (mitgeliefert oder heruntergeladen) laden
        loadShippers(this.path);

        // ==========================================
        // Seite 1: Sendungen & Anzeige
        // ==========================================
        const pageParcels = new Adw.PreferencesPage({
            title: 'Sendungen',
            icon_name: 'view-list-symbolic',
        });
        window.add(pageParcels);

        // --- Neue Sendung ---
        const groupAdd = new Adw.PreferencesGroup({
            title: 'Sendung hinzufügen',
            description: 'Die Sendungsnummer findest du in der Versandbestätigung. DHL wird per API abgefragt, bei den anderen Versendern öffnet ein Klick auf die Karte die Sendungsverfolgung.',
        });
        pageParcels.add(groupAdd);

        const carrierLabel = id => {
            const c = getCarrier(id);
            return c.api ? `${c.name} (Status per API)` : `${c.name} (nur Link)`;
        };
        const carrierRow = new Adw.ComboRow({ title: 'Versender' });
        const fillCarrierRow = () => {
            const previous = carrierIds()[carrierRow.selected];
            carrierRow.model = new Gtk.StringList({ strings: carrierIds().map(carrierLabel) });
            const idx = carrierIds().indexOf(previous);
            carrierRow.selected = idx >= 0 ? idx : 0;
        };
        fillCarrierRow();
        groupAdd.add(carrierRow);

        const numberRow = new Adw.EntryRow({ title: 'Sendungsnummer' });
        groupAdd.add(numberRow);

        const labelRow = new Adw.EntryRow({ title: 'Bezeichnung (optional, z. B. „Kopfhörer“)' });
        groupAdd.add(labelRow);

        const addRow = new Adw.ActionRow({
            title: 'Sendung zur Liste hinzufügen',
            subtitle: 'Doppelte Sendungsnummern werden erkannt',
        });
        const addBtn = new Gtk.Button({
            label: 'Hinzufügen',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addRow.add_suffix(addBtn);
        addRow.activatable_widget = addBtn;
        groupAdd.add(addRow);

        // Hinweis zum Nummernformat des gewählten Versenders (aus der Datenbank)
        const ADD_SUBTITLE = 'Doppelte Sendungsnummern werden erkannt';
        const showCarrierHint = () => {
            addRow.subtitle = getCarrier(carrierIds()[carrierRow.selected]).numberHint || ADD_SUBTITLE;
        };
        carrierRow.connect('notify::selected', showCarrierHint);
        showCarrierHint();

        // --- Liste: je Versender eine aufklappbare Zeile ---
        const groupList = new Adw.PreferencesGroup({
            title: 'Eingetragene Sendungen',
        });
        pageParcels.add(groupList);

        // Aufgeklappte Versender merken, damit die Liste beim Neuaufbau (z. B. nach
        // einem Löschen oder einer neuen Statusabfrage) nicht wieder zuklappt.
        const expandedCarriers = new Set();
        let listRows = [];

        const removeParcels = predicate => {
            const rest = parseParcels(settings.get_string('parcels')).filter(p => !predicate(p));
            settings.set_string('parcels', serializeParcels(rest));
        };

        const rebuildList = () => {
            for (const row of listRows)
                groupList.remove(row);
            listRows = [];

            const parcels = parseParcels(settings.get_string('parcels'));
            const cache = parseCache(settings.get_string('parcel-cache'));

            groupList.description = parcels.length === 0
                ? 'Noch keine Sendungen eingetragen.'
                : `${parcels.length} Sendung${parcels.length === 1 ? '' : 'en'}`;

            // Versender in Datenbank-Reihenfolge, danach solche, die nicht mehr in der
            // Datenbank stehen (ihre Sendungen bleiben erhalten und löschbar)
            const orphanIds = [...new Set(parcels.map(p => p.carrier))].filter(id => !carrierIds().includes(id));
            for (const carrierId of [...carrierIds(), ...orphanIds]) {
                const carrier = getCarrier(carrierId);
                const own = parcels.filter(p => p.carrier === carrierId);
                if (own.length === 0)
                    continue;

                const delivered = own.filter(p => cache[p.id]?.state === 'delivered').length;
                const active = own.length - delivered;
                const parts = [carrier.unknown
                    ? 'nicht mehr in der Versender-Datenbank'
                    : carrier.api ? 'Status per API' : 'nur Link zur Sendungsverfolgung'];
                parts.push(`${active} unterwegs`);
                if (delivered > 0)
                    parts.push(`${delivered} zugestellt`);

                const expander = new Adw.ExpanderRow({
                    title: GLib.markup_escape_text(carrier.name, -1),
                    subtitle: GLib.markup_escape_text(parts.join(' • '), -1),
                    show_enable_switch: false,
                    expanded: expandedCarriers.has(carrierId),
                });
                expander.connect('notify::expanded', () => {
                    if (expander.expanded)
                        expandedCarriers.add(carrierId);
                    else
                        expandedCarriers.delete(carrierId);
                });

                // Anzahl als Kennzeichen rechts neben dem Pfeil
                expander.add_suffix(new Gtk.Label({
                    label: String(own.length),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['dim-label', 'numeric'],
                }));

                for (const parcel of own) {
                    const entry = cache[parcel.id];
                    const row = new Adw.ActionRow({
                        title: GLib.markup_escape_text(parcel.label || parcel.number, -1),
                        subtitle: GLib.markup_escape_text(
                            `${parcel.label ? `${parcel.number} • ` : ''}${entry?.statusText ?? 'noch nicht abgefragt'}`, -1),
                    });
                    const removeBtn = new Gtk.Button({
                        icon_name: 'user-trash-symbolic',
                        valign: Gtk.Align.CENTER,
                        tooltip_text: 'Sendung entfernen',
                        css_classes: ['flat'],
                    });
                    removeBtn.connect('clicked', () => removeParcels(p => p.id === parcel.id));
                    row.add_suffix(removeBtn);
                    expander.add_row(row);
                }

                if (delivered > 0) {
                    const cleanRow = new Adw.ActionRow({
                        title: 'Zugestellte Sendungen entfernen',
                        subtitle: `${delivered} zugestellte Sendung${delivered === 1 ? '' : 'en'} von ${carrier.name} aus der Liste löschen`,
                    });
                    const cleanBtn = new Gtk.Button({
                        label: 'Entfernen',
                        valign: Gtk.Align.CENTER,
                    });
                    cleanBtn.connect('clicked', () => removeParcels(p =>
                        p.carrier === carrierId && cache[p.id]?.state === 'delivered'));
                    cleanRow.add_suffix(cleanBtn);
                    expander.add_row(cleanRow);
                }

                groupList.add(expander);
                listRows.push(expander);
            }
        };
        rebuildList();
        const parcelsSignal = settings.connect('changed::parcels', rebuildList);
        const cacheSignal = settings.connect('changed::parcel-cache', rebuildList);
        window.connect('close-request', () => {
            settings.disconnect(parcelsSignal);
            settings.disconnect(cacheSignal);
            return false;
        });

        const addParcel = () => {
            const number = normalizeNumber(numberRow.text);
            const error = validateNumber(number);
            if (error) {
                addRow.subtitle = error;
                numberRow.add_css_class('error');
                return;
            }
            numberRow.remove_css_class('error');

            const carrierId = carrierIds()[carrierRow.selected];
            if (!carrierId) {
                addRow.subtitle = 'Kein Versender ausgewählt';
                return;
            }
            const parcel = makeParcel(carrierId, number, labelRow.text);
            const parcels = parseParcels(settings.get_string('parcels'));
            if (parcels.some(p => p.id === parcel.id)) {
                addRow.subtitle = 'Diese Sendung ist bereits eingetragen';
                return;
            }
            parcels.push(parcel);
            expandedCarriers.add(parcel.carrier);
            settings.set_string('parcels', serializeParcels(parcels));

            numberRow.text = '';
            labelRow.text = '';
            addRow.subtitle = `Hinzugefügt: ${parcel.label || parcel.number}`;
        };
        addBtn.connect('clicked', addParcel);
        numberRow.connect('entry-activated', addParcel);
        labelRow.connect('entry-activated', addParcel);

        // --- Anzeige ---
        const groupPanel = new Adw.PreferencesGroup({
            title: 'Anzeige & Abfrage',
            description: 'Die Zahl neben dem Paket-Symbol zeigt, wie viele Sendungen noch unterwegs sind',
        });
        pageParcels.add(groupPanel);

        const positionRow = new Adw.ComboRow({
            title: 'Position im Panel',
            subtitle: 'Wähle den Anzeigeort in der oberen Leiste',
            model: new Gtk.StringList({
                strings: ['Mitte (neben Datum/Uhrzeit)', 'Rechts (neben Quick Settings)'],
            }),
        });
        positionRow.selected = settings.get_string('panel-position') === 'center' ? 0 : 1;
        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', positionRow.selected === 0 ? 'center' : 'right');
        });
        groupPanel.add(positionRow);

        const intervalRow = new Adw.SpinRow({
            title: 'Aktualisierungsintervall',
            subtitle: 'Minuten zwischen zwei Abfragen. Die DHL-API erlaubt 250 Anfragen pro Tag – zugestellte Sendungen werden nicht mehr abgefragt.',
            adjustment: new Gtk.Adjustment({
                lower: 15,
                upper: 240,
                step_increment: 5,
                page_increment: 30,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupPanel.add(intervalRow);

        const hideRow = new Adw.SpinRow({
            title: 'Zugestellte Sendungen ausblenden nach',
            subtitle: 'Tage nach der Zustellung (0 = nie ausblenden)',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 30,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('hide-delivered-days'),
            }),
        });
        settings.bind('hide-delivered-days', hideRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupPanel.add(hideRow);

        // ==========================================
        // Seite 2: DHL (Zugangsdaten im Schlüsselbund)
        // ==========================================
        const pageDhl = new Adw.PreferencesPage({
            title: 'DHL',
            icon_name: 'network-server-symbolic',
        });
        window.add(pageDhl);

        const groupDhl = new Adw.PreferencesGroup({
            title: 'DHL Shipment Tracking API',
            description: 'Einen kostenlosen API-Key gibt es im DHL Developer Portal (Konto anlegen, App erstellen, „Shipment Tracking – Unified“ auswählen). Standardlimit: 250 Anfragen pro Tag, 1 pro Sekunde.',
        });
        pageDhl.add(groupDhl);

        // Key liegt im GNOME-Schlüsselbund, nicht in dconf
        const keyRow = new Adw.PasswordEntryRow({
            title: 'API-Key',
            show_apply_button: true,
        });
        groupDhl.add(keyRow);

        const keyInfoRow = new Adw.ActionRow({
            title: 'Speicherort',
            subtitle: 'GNOME-Schlüsselbund – wird geladen …',
        });
        groupDhl.add(keyInfoRow);

        let storedKey = null;

        lookupSecret(DHL_SECRET)
            .then(key => {
                storedKey = key ?? '';
                keyRow.text = storedKey;
                keyInfoRow.subtitle = key
                    ? 'Im GNOME-Schlüsselbund hinterlegt (verschlüsselt)'
                    : 'Kein Key hinterlegt';
            })
            .catch(e => {
                keyInfoRow.subtitle = `Schlüsselbund nicht erreichbar: ${e.message}`;
            });

        const saveKey = async () => {
            const key = keyRow.text.trim();
            if (storedKey === null || key === storedKey)
                return;
            try {
                if (key)
                    await storeSecret(DHL_SECRET, key);
                else
                    await clearSecret(DHL_SECRET);
                storedKey = key;
                settings.set_int('dhl-key-revision', settings.get_int('dhl-key-revision') + 1);
                keyInfoRow.subtitle = key
                    ? 'Im GNOME-Schlüsselbund gespeichert (verschlüsselt)'
                    : 'Key aus dem Schlüsselbund entfernt';
            } catch (e) {
                keyInfoRow.subtitle = `Speichern fehlgeschlagen: ${e.message}`;
            }
        };
        keyRow.connect('apply', saveKey);
        keyRow.connect('entry-activated', saveKey);
        window.connect('close-request', () => {
            saveKey();
            return false;
        });

        const portalRow = new Adw.ActionRow({
            title: 'DHL Developer Portal',
            subtitle: 'developer.dhl.com',
        });
        const portalBtn = new Gtk.Button({
            label: 'Öffnen',
            valign: Gtk.Align.CENTER,
        });
        portalBtn.connect('clicked', () => {
            try {
                Gio.AppInfo.launch_default_for_uri('https://developer.dhl.com/', null);
            } catch (e) {
                portalRow.subtitle = `Link konnte nicht geöffnet werden: ${e.message}`;
            }
        });
        portalRow.add_suffix(portalBtn);
        groupDhl.add(portalRow);

        // ==========================================
        // Seite 3: Updates
        // ==========================================
        const pageUpdate = new Adw.PreferencesPage({
            title: 'Updates',
            icon_name: 'software-update-available-symbolic',
        });
        window.add(pageUpdate);

        const installedName = this.metadata['version-name'] ?? String(this.metadata.version || 1);
        const installedVersion = Number(this.metadata.version || 1);
        const updateCommand = 'curl -fsSL https://raw.githubusercontent.com/joeMJ/packetbar/main/install.sh | bash';

        // --- Programm (Git) ---
        const groupUpdate = new Adw.PreferencesGroup({
            title: 'Programm',
            description: 'Prüfung auf neue Versionen über GitHub (github.com/joeMJ/packetbar). Neuer Programmcode wird erst nach dem Ab- und Anmelden aktiv.',
        });
        pageUpdate.add(groupUpdate);

        const updateEnableRow = new Adw.SwitchRow({
            title: 'Automatische Versionsprüfung',
            subtitle: 'Prüft regelmäßig, ob im Git-Repository ein Update vorliegt (Hinweis im Popup)',
        });
        settings.bind('update-check-enabled', updateEnableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupUpdate.add(updateEnableRow);

        const gitUrlRow = new Adw.EntryRow({ title: 'Git Repository URL' });
        settings.bind('git-update-url', gitUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        groupUpdate.add(gitUrlRow);

        const gitRawUrlRow = new Adw.EntryRow({ title: 'Raw Metadata URL (Versionsabgleich)' });
        settings.bind('git-raw-metadata-url', gitRawUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        groupUpdate.add(gitRawUrlRow);

        // Anzeige: installiert / verfügbar
        const statusRow = new Adw.ActionRow({
            title: `Installierte Version: v${installedName}`,
            subtitle: 'Noch nicht geprüft',
        });
        const statusIcon = new Gtk.Image({ icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER });
        statusRow.add_prefix(statusIcon);
        const checkBtn = new Gtk.Button({ label: 'Jetzt prüfen', valign: Gtk.Align.CENTER });
        statusRow.add_suffix(checkBtn);
        groupUpdate.add(statusRow);

        const installRow = new Adw.ActionRow({
            title: 'Installieren / aktualisieren',
            subtitle: `Im Terminal: ${updateCommand}`,
            subtitle_selectable: true,
        });
        const updateBtn = new Gtk.Button({
            label: 'Jetzt aktualisieren',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        updateBtn.connect('clicked', () => {
            const error = launchInTerminal(
                `${updateCommand}; echo; read -r -p 'Fertig – danach ab- und wieder anmelden. Enter schließt das Fenster.'`);
            if (error)
                installRow.subtitle = `${error} – bitte manuell ausführen: ${updateCommand}`;
        });
        installRow.add_suffix(updateBtn);
        groupUpdate.add(installRow);

        const checker = new UpdateChecker(installedVersion);
        const setStatus = (icon, subtitle, cssClass = null) => {
            statusIcon.icon_name = icon;
            for (const c of ['success', 'warning', 'error'])
                statusIcon.remove_css_class(c);
            if (cssClass)
                statusIcon.add_css_class(cssClass);
            statusRow.subtitle = GLib.markup_escape_text(subtitle, -1);
        };
        const checkProgram = async () => {
            checkBtn.sensitive = false;
            setStatus('view-refresh-symbolic', 'Prüfe auf neue Version …');
            try {
                const r = await checker.checkForUpdates(settings.get_string('git-raw-metadata-url'));
                if (r.error)
                    setStatus('dialog-warning-symbolic', `Prüfung fehlgeschlagen: ${r.error}`, 'warning');
                else if (r.updateAvailable)
                    setStatus('software-update-available-symbolic',
                        `Neue Version verfügbar: v${r.remoteVersionName} (installiert: v${installedName}). Mit „Jetzt aktualisieren“ installieren und danach ab- und wieder anmelden.`,
                        'warning');
                else
                    setStatus('emblem-ok-symbolic', `Aktuell – v${installedName} ist die neueste Version`, 'success');
            } catch (e) {
                setStatus('dialog-warning-symbolic', `Prüfung fehlgeschlagen: ${e.message}`, 'warning');
            }
            checkBtn.sensitive = true;
        };
        checkBtn.connect('clicked', checkProgram);
        if (settings.get_boolean('update-check-enabled'))
            checkProgram();

        // --- Versender-Datenbank ---
        const groupDb = new Adw.PreferencesGroup({
            title: 'Versender-Datenbank',
            description: 'Namen und Links der Versender liegen als JSON im Git-Repository. Ein Update der Datenbank wirkt sofort, ohne Ab- und Anmelden.',
        });
        pageUpdate.add(groupDb);

        const dbAutoRow = new Adw.SwitchRow({
            title: 'Datenbank automatisch aktualisieren',
            subtitle: 'Lädt bei jeder Statusabfrage eine neuere Version (reine Daten, keine Programme)',
        });
        settings.bind('shipper-db-auto-update', dbAutoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupDb.add(dbAutoRow);

        const dbUrlRow = new Adw.EntryRow({ title: 'URL der Versender-Datenbank (https)' });
        settings.bind('shipper-db-url', dbUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        groupDb.add(dbUrlRow);

        const dbRow = new Adw.ActionRow({ title: 'Installierte Datenbank' });
        const dbIcon = new Gtk.Image({ icon_name: 'emblem-ok-symbolic', valign: Gtk.Align.CENTER });
        dbRow.add_prefix(dbIcon);
        const dbBtn = new Gtk.Button({ label: 'Jetzt aktualisieren', valign: Gtk.Align.CENTER });
        dbRow.add_suffix(dbBtn);
        groupDb.add(dbRow);

        const describeDb = () => {
            const info = shipperInfo();
            dbRow.title = `Installierte Datenbank: v${info.version}`;
            return `${info.count} Versender${info.updated ? ` • Stand ${info.updated}` : ''}`;
        };
        const setDbStatus = (icon, text, cssClass = null) => {
            dbIcon.icon_name = icon;
            for (const c of ['success', 'warning', 'error'])
                dbIcon.remove_css_class(c);
            if (cssClass)
                dbIcon.add_css_class(cssClass);
            dbRow.subtitle = GLib.markup_escape_text(text, -1);
        };
        setDbStatus('emblem-ok-symbolic', describeDb());

        const checkDb = async () => {
            dbBtn.sensitive = false;
            setDbStatus('view-refresh-symbolic', 'Prüfe auf neue Datenbank …');
            const r = await updateShippers(settings.get_string('shipper-db-url'));
            if (r.status === 'updated') {
                // Extension und diese Seite laden die neue Datenbank sofort
                settings.set_int('shipper-db-revision', settings.get_int('shipper-db-revision') + 1);
                fillCarrierRow();
                showCarrierHint();
                rebuildList();
                const skipped = r.skipped > 0 ? ` (${r.skipped} ungültige Einträge übersprungen)` : '';
                setDbStatus('emblem-ok-symbolic',
                    `Aktualisiert: v${r.localVersion} → v${r.remoteVersion} – sofort aktiv. ${describeDb()}${skipped}`, 'success');
            } else if (r.status === 'current') {
                setDbStatus('emblem-ok-symbolic', `Aktuell – ${describeDb()}`, 'success');
            } else {
                setDbStatus('dialog-warning-symbolic', `Prüfung fehlgeschlagen: ${r.error}`, 'warning');
            }
            dbBtn.sensitive = true;
        };
        dbBtn.connect('clicked', checkDb);
        if (settings.get_boolean('shipper-db-auto-update'))
            checkDb();
    }
}

/**
 * Startet einen Befehl in einem Terminalfenster (bevorzugt das Standard-Terminal
 * über xdg-terminal-exec, sonst Ptyxis, GNOME Terminal, x-terminal-emulator).
 * @param {string} command - Shell-Befehl für bash -c
 * @returns {string|null} Fehlermeldung oder null bei Erfolg
 */
function launchInTerminal(command) {
    const candidates = [
        ['xdg-terminal-exec', []],
        ['ptyxis', ['--']],
        ['gnome-terminal', ['--']],
        ['x-terminal-emulator', ['-e']],
    ];
    for (const [program, prefix] of candidates) {
        const path = GLib.find_program_in_path(program);
        if (!path)
            continue;
        try {
            Gio.Subprocess.new([path, ...prefix, 'bash', '-c', command], Gio.SubprocessFlags.NONE);
            return null;
        } catch (e) {
            console.warn(`[packetbar] ${program} konnte nicht gestartet werden: ${e.message}`);
        }
    }
    return 'Kein Terminal gefunden';
}
