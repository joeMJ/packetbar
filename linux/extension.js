/**
 * extension.js - Haupteinstiegspunkt für packetbar (GNOME 46 - 50)
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { PacketIndicator } from './src/indicator.js';
import { DhlClient } from './src/dhlClient.js';
import { Track17Client } from './src/track17Client.js';
import { UpdateChecker } from './src/updater.js';
import { lookupSecretNoPrompt } from './src/secretStore.js';
import {
    parseParcels, parseCache, dayKey, getCarrier, parseCarrierIntervals, isDue,
    effectiveInterval, notificationsDue, formatTime,
} from './src/parcelUtil.js';
import { parseCarrierSources, providerChain } from './src/shippers.js';
import { loadShippers, updateShippers } from './src/shipperDb.js';

const RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
const MANUAL_REFRESH_GAP_MS = 30 * 1000;

export default class PacketBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();

        // Status-Anbieter: Client und Schlüsselbund-Eintrag sind bewusst fest im Code und
        // nicht Teil der Versender-Datenbank – diese verweist nur per `provider` darauf.
        // dailyLimit / gapMs schonen die jeweilige API:
        //  - DHL: 250 Anfragen/Tag, 1 Anfrage/Sekunde
        //  - 17TRACK: 3 Anfragen/Sekunde, kein festes Tageslimit für Statusabfragen
        this._providers = {
            dhl: {
                client: new DhlClient(), secret: 'dhl-api-key', label: 'DHL',
                dailyLimit: 240, gapMs: 1300, pausedUntil: 0,
            },
            '17track': {
                client: new Track17Client(), secret: '17track-api-key', label: '17TRACK',
                dailyLimit: 400, gapMs: 500, pausedUntil: 0,
            },
        };

        // Versender-Datenbank (mitgeliefert oder heruntergeladen, die neuere gilt)
        this._shipperInfo = loadShippers(this.path);
        this._updateChecker = new UpdateChecker(this.metadata.version || 1);

        this._cache = parseCache(this._settings.get_string('parcel-cache'));
        this._budget = this._loadBudget();
        this._lastUpdateStatus = null;
        // Letzter erfolgreicher Abruf, auch über Neustarts der Shell hinweg
        const lastFetched = Math.max(0, ...Object.values(this._cache).map(e => e?.fetchedAt ?? 0));
        this._lastTimestamp = lastFetched > 0 ? new Date(lastFetched) : null;
        this._lastFetchStart = 0;
        this._hint = null;
        this._isOffline = false;

        this._followUpAt = 0;
        this._attemptAt = new Map();      // letzter Abfrageversuch je Sendung (nur im Speicher)
        this._lastMetaCheck = 0;          // letzte Prüfung auf neue Version / Versender-Datenbank
        this._refreshing = false;
        this._pendingFull = false;
        this._pendingRefresh = false;

        this._timeoutId = null;
        this._retryTimeoutId = null;
        this._resumeTimeoutId = null;
        this._sleepSourceId = null;
        this._sleepResolve = null;
        this._networkMonitor = null;
        this._netChangedId = null;
        this._sleepSignalId = null;

        this._createIndicator();

        // Nur auf die relevanten Einstellungen reagieren – ein generisches
        // 'changed' würde bei jedem Cache-Schreibzugriff eine API-Abfrage auslösen.
        this._settingsSignals = [];
        const on = (key, fn) => this._settingsSignals.push(this._settings.connect(`changed::${key}`, fn));
        on('panel-position', () => this._repositionIndicator());
        on('refresh-interval', () => this._restartTimer());
        on('hide-delivered-days', () => this._applyDataToUI());
        on('parcels', () => {
            this._applyDataToUI();
            // Nur neue Sendungen abfragen, bestehende nicht erneut
            this.refreshData({ onlyMissing: true });
        });
        on('dhl-key-revision', () => this.refreshData({ force: true }));
        on('track17-key-revision', () => this.refreshData({ force: true }));
        // Andere Status-Quelle für einen Versender gewählt → neu abfragen
        on('carrier-sources', () => this.refreshData({ force: true }));
        // Datenbank in den Einstellungen aktualisiert → neu einlesen, kein Neustart nötig
        on('shipper-db-revision', () => {
            this._shipperInfo = loadShippers(this.path);
            this._applyDataToUI();
        });

        this._setupNetworkMonitor();
        this._setupSleepMonitor();
        this._restartTimer();

        // Gespeicherte Stände sofort anzeigen, dann abfragen
        this._applyDataToUI();
        this.refreshData({ onlyMissing: true });
    }

    disable() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        for (const key of ['_timeoutId', '_retryTimeoutId', '_resumeTimeoutId', '_sleepSourceId']) {
            if (this[key]) {
                GLib.Source.remove(this[key]);
                this[key] = null;
            }
        }
        if (this._sleepResolve) {
            this._sleepResolve();
            this._sleepResolve = null;
        }

        if (this._netChangedId && this._networkMonitor) {
            this._networkMonitor.disconnect(this._netChangedId);
            this._netChangedId = null;
        }
        this._networkMonitor = null;

        if (this._sleepSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
            this._sleepSignalId = null;
        }

        if (this._settingsSignals && this._settings) {
            for (const id of this._settingsSignals)
                this._settings.disconnect(id);
            this._settingsSignals = [];
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._providers = null;
        this._updateChecker = null;
        this._settings = null;
    }

    // -----------------------------------------------------------------------
    // Überwachung von Netzwerk und Standby
    // -----------------------------------------------------------------------

    _isStale() {
        if (!this._lastTimestamp)
            return true;
        const intervalMs = this._intervalMinutes() * 60 * 1000;
        return Date.now() - this._lastTimestamp.getTime() > intervalMs;
    }

    _setupNetworkMonitor() {
        try {
            this._networkMonitor = Gio.NetworkMonitor.get_default();
            if (this._networkMonitor) {
                this._netChangedId = this._networkMonitor.connect('network-changed', (_monitor, available) => {
                    if (available && (this._isOffline || this._isStale()))
                        this._scheduleResumeRefresh(3);
                });
            }
        } catch (e) {
            console.warn(`[packetbar] Failed to initialize NetworkMonitor: ${e.message}`);
        }
    }

    _setupSleepMonitor() {
        try {
            this._sleepSignalId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    try {
                        const [aboutToSuspend] = params.recursiveUnpack();
                        if (aboutToSuspend) {
                            this._clearSource('_retryTimeoutId');
                            this._clearSource('_resumeTimeoutId');
                        } else {
                            this._restartTimer();
                            // Nach dem Aufwachen nur abfragen, wenn der Stand veraltet ist
                            // (schont das Tageslimit der API)
                            if (this._isStale())
                                this._scheduleResumeRefresh(6);
                        }
                    } catch (err) {
                        console.warn(`[packetbar] Error in PrepareForSleep signal callback: ${err.message}`);
                    }
                }
            );
        } catch (e) {
            console.warn(`[packetbar] Failed to subscribe to PrepareForSleep: ${e.message}`);
        }
    }

    _clearSource(field) {
        if (this[field]) {
            GLib.Source.remove(this[field]);
            this[field] = null;
        }
    }

    _scheduleResumeRefresh(seconds) {
        this._clearSource('_resumeTimeoutId');
        this._resumeTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._resumeTimeoutId = null;
            this.refreshData();
            return GLib.SOURCE_REMOVE;
        });
    }

    // -----------------------------------------------------------------------
    // Indicator & Timer
    // -----------------------------------------------------------------------

    _createIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._indicator = new PacketIndicator(this);
        const position = this._settings.get_string('panel-position') || 'right';

        // 0 = Index, position = 'center' oder 'right'
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, position);
    }

    _repositionIndicator() {
        this._createIndicator();
        this._applyDataToUI();
    }

    _intervalMinutes() {
        return Math.max(15, this._settings.get_int('refresh-interval'));
    }

    /** Abfrageintervall (Minuten) für einen Versender: eigene Einstellung oder das Standardintervall. */
    _intervalFor(carrierId) {
        return effectiveInterval({
            own: parseCarrierIntervals(this._settings.get_string('carrier-intervals'))[carrierId],
            globalMin: this._intervalMinutes(),
            // Hat der Nutzer das allgemeine Intervall nie angefasst, gilt die Vorgabe des Versenders
            globalIsUserSet: this._settings.get_user_value('refresh-interval') !== null,
            carrier: getCarrier(carrierId),
        });
    }

    // -----------------------------------------------------------------------
    // Benachrichtigungen
    // -----------------------------------------------------------------------

    _loadNotified() {
        try {
            const data = JSON.parse(this._settings.get_string('notified-events') || '{}');
            return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        } catch (_e) {
            return {};
        }
    }

    /**
     * Prüft für alle Sendungen, ob eine Benachrichtigung fällig ist („heute“, „in Kürze“).
     * Jede Art wird je Sendung höchstens einmal pro Tag gemeldet, auch über Neustarts hinweg.
     */
    _checkNotifications() {
        if (!this._settings)
            return;
        const opts = {
            today: this._settings.get_boolean('notify-today'),
            soon: this._settings.get_boolean('notify-soon'),
            soonMinutes: this._settings.get_int('notify-soon-minutes'),
        };
        const parcels = parseParcels(this._settings.get_string('parcels'));
        const notified = this._loadNotified();
        let changed = false;

        // Einträge entfernter Sendungen verwerfen
        const ids = new Set(parcels.map(p => p.id));
        for (const id of Object.keys(notified)) {
            if (!ids.has(id)) {
                delete notified[id];
                changed = true;
            }
        }

        if (opts.today || opts.soon) {
            const now = Date.now();
            for (const parcel of parcels) {
                const entry = this._cache[parcel.id];
                const due = notificationsDue({ entry, notified: notified[parcel.id], now, opts });
                for (const kind of due) {
                    this._notify(parcel, entry, kind);
                    notified[parcel.id] = { ...notified[parcel.id], [kind]: dayKey(new Date(now)) };
                    changed = true;
                }
            }
        }

        if (changed)
            this._settings.set_string('notified-events', JSON.stringify(notified));
    }

    _notify(parcel, entry, kind) {
        const carrier = getCarrier(parcel.carrier);
        const name = parcel.label || parcel.number;
        let title;
        let body;
        if (kind === 'soon') {
            title = 'Dein Paket kommt gleich';
            const from = formatTime(entry.etaFromMs);
            const to = formatTime(entry.etaToMs);
            body = `${name} (${carrier.name}) – Zustellung ${from === to ? `gegen ${from}` : `zwischen ${from} und ${to}`} Uhr`;
        } else {
            title = 'Dein Paket wird heute zugestellt';
            body = `${name} (${carrier.name})`;
        }
        try {
            Main.notify(title, body);
        } catch (e) {
            console.warn(`[packetbar] Benachrichtigung fehlgeschlagen: ${e.message}`);
        }
    }

    _restartTimer() {
        this._clearSource('_timeoutId');

        // Der Takt ist kurz, abgefragt wird aber nur, was laut Intervall des Versenders fällig ist.
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
            () => {
                this.refreshData();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _scheduleRetry(seconds) {
        this._clearSource('_retryTimeoutId');

        this._retryTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._retryTimeoutId = null;
            this.refreshData();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Wartet `ms` Millisekunden; endet sofort, wenn die Extension deaktiviert wird. */
    _sleep(ms) {
        return new Promise(resolve => {
            this._sleepResolve = resolve;
            this._sleepSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._sleepSourceId = null;
                this._sleepResolve = null;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // -----------------------------------------------------------------------
    // Anfrage-Budget (Tageslimit der API)
    // -----------------------------------------------------------------------

    _loadBudget() {
        try {
            const data = JSON.parse(this._settings.get_string('request-budget') || '{}');
            if (data.day === dayKey() && data.counts && typeof data.counts === 'object')
                return { day: data.day, counts: { ...data.counts } };
            // Altes Format (vor 0.5): ein einzelner Zähler, gehörte zu DHL
            if (data.day === dayKey() && Number.isFinite(data.count))
                return { day: data.day, counts: { dhl: data.count } };
        } catch (_e) {
            // ungültig → neu beginnen
        }
        return { day: dayKey(), counts: {} };
    }

    _rollBudget() {
        if (this._budget.day !== dayKey())
            this._budget = { day: dayKey(), counts: {} };
    }

    _countRequests(providerId, n = 1) {
        this._rollBudget();
        this._budget.counts[providerId] = (this._budget.counts[providerId] ?? 0) + n;
        this._settings?.set_string('request-budget', JSON.stringify(this._budget));
    }

    _budgetLeft(providerId) {
        this._rollBudget();
        return this._providers[providerId].dailyLimit - (this._budget.counts[providerId] ?? 0);
    }

    _requestsToday() {
        this._rollBudget();
        return Object.values(this._budget.counts).reduce((a, b) => a + b, 0);
    }

    // -----------------------------------------------------------------------
    // Schlüsselbund
    // -----------------------------------------------------------------------

    /**
     * Liest einen API-Key aus dem Schlüsselbund – niemals mit Entsperr-Dialog, da ein
     * Dialog aus dem Shell-Prozess GNOME Shell abstürzen lassen kann.
     * @returns {Promise<{value: string|null, locked: boolean}>}
     */
    async _getSecret(name) {
        try {
            return await lookupSecretNoPrompt(name, this._cancellable);
        } catch (e) {
            if (!this._cancellable?.is_cancelled())
                console.warn(`[packetbar] Schlüsselbund nicht lesbar: ${e.message}`);
            return { value: null, locked: false };
        }
    }

    // -----------------------------------------------------------------------
    // Datenabruf
    // -----------------------------------------------------------------------

    _needsFetch(parcel, { onlyMissing, force }) {
        const entry = this._cache[parcel.id];
        if (entry?.state === 'delivered')
            return false;          // zugestellte Sendungen nie erneut abfragen
        if (onlyMissing)
            return !entry;
        if (force)
            return true;
        return isDue({
            entry,
            attemptAt: this._attemptAt.get(parcel.id) ?? 0,
            intervalMin: this._intervalFor(parcel.carrier),
        });
    }

    _saveCache(parcels) {
        // Einträge entfernter Sendungen verwerfen
        const ids = new Set(parcels.map(p => p.id));
        for (const id of Object.keys(this._cache)) {
            if (!ids.has(id))
                delete this._cache[id];
        }
        this._settings?.set_string('parcel-cache', JSON.stringify(this._cache));
    }

    /**
     * Fragt alle Sendungen eines Status-Anbieters nacheinander ab (Spike Arrest).
     * @returns {Promise<{hint: object|null, offline: boolean, resolved: Set<string>}>}
     *   `resolved`: IDs der Sendungen, zu denen der Anbieter eine eindeutige Antwort geliefert
     *   hat (Status oder „unbekannt“) – für alle anderen darf der nächste Anbieter einspringen.
     */
    async _fetchProvider(providerId, targets) {
        const provider = this._providers[providerId];
        const { client, secret: secretName } = provider;
        const resolved = new Set();
        const notFound = new Set();

        const { value: apiKey, locked } = await this._getSecret(secretName);
        if (!apiKey) {
            if (locked)
                this._scheduleRetry(60);   // ohne Dialog warten, bis der Schlüsselbund entsperrt ist
            return { hint: { kind: locked ? 'locked' : 'nokey', provider: providerId }, offline: false, resolved, notFound };
        }

        if (Date.now() < provider.pausedUntil)
            return { hint: { kind: 'ratelimit', provider: providerId }, offline: false, resolved, notFound };

        let hint = null;
        let offline = false;

        for (let i = 0; i < targets.length; i++) {
            if (!this._cancellable || this._cancellable.is_cancelled())
                break;

            if (this._budgetLeft(providerId) <= 0) {
                hint = { kind: 'budget', provider: providerId };
                break;
            }

            const parcel = targets[i];
            this._attemptAt.set(parcel.id, Date.now());
            const options = getCarrier(parcel.carrier).providerOptions?.[providerId] ?? {};
            const res = await client.fetchShipment(apiKey, parcel.number, this._cancellable, options);
            if (res.error === 'cancelled' || res.error === 'network')
                this._attemptAt.delete(parcel.id);   // kein echter Versuch – beim nächsten Takt erneut
            if (res.error === 'cancelled')
                break;
            if (res.error !== 'network')
                this._countRequests(providerId, res.requests ?? 1);

            if (res.ok) {
                this._cache[parcel.id] = { ...res, source: providerId, fetchedAt: Date.now() };
                resolved.add(parcel.id);
                if (res.registered)
                    this._followUpAt = Date.now();   // frisch registriert: erste Daten kommen nach ca. 1 Minute
            } else if (res.error === 'notfound') {
                // „Nicht gefunden“ ist noch keine endgültige Antwort: ein weiterer Anbieter kennt
                // die Sendung vielleicht (z. B. DHL-API kennt manche Nummern nicht). Der Eintrag
                // „Noch keine Daten“ wird erst geschrieben, wenn keiner mehr übrig ist.
                notFound.add(parcel.id);
                console.log(`[packetbar] ${provider.label}: ${parcel.number} nicht gefunden (${res.message})`);
            } else if (res.error === 'auth') {
                hint = { kind: 'auth', provider: providerId };
                break;                     // Key falsch – keine weiteren Anfragen verschwenden
            } else if (res.error === 'ratelimit') {
                provider.pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
                hint = { kind: 'ratelimit', provider: providerId };
                break;
            } else if (res.error === 'quota') {
                hint = { kind: 'quota', provider: providerId };
                break;                     // Kontingent leer – weitere Registrierungen sind zwecklos
            } else if (res.error === 'network') {
                offline = true;
                break;
            }
            // Andere HTTP-Fehler: alten Stand behalten, nächste Sendung versuchen

            if (i < targets.length - 1)
                await this._sleep(provider.gapMs);
        }

        return { hint, offline, resolved, notFound };
    }

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.force]       alle aktiven Sendungen abfragen (Standard bei Timer)
     * @param {boolean} [opts.onlyMissing] nur Sendungen ohne gespeicherten Stand abfragen
     * @param {boolean} [opts.manual]      per Knopfdruck ausgelöst (mindestens 30 s Abstand)
     */
    async refreshData(opts = {}) {
        if (!this._settings || !this._indicator)
            return;

        if (this._refreshing) {
            // Läuft schon – danach noch einmal, falls dieser Aufruf mehr verlangt
            this._pendingRefresh = true;
            this._pendingFull = this._pendingFull || !opts.onlyMissing;
            return;
        }

        if (opts.manual && Date.now() - this._lastFetchStart < MANUAL_REFRESH_GAP_MS) {
            this._applyDataToUI();
            return;
        }

        this._refreshing = true;
        this._clearSource('_retryTimeoutId');
        this._lastFetchStart = Date.now();

        try {
            const onlyMissing = !!opts.onlyMissing && !opts.force;
            const parcels = parseParcels(this._settings.get_string('parcels'));
            const updateEnabled = this._settings.get_boolean('update-check-enabled');
            const updateUrl = this._settings.get_string('git-raw-metadata-url');

            // Versions- und Datenbankprüfung höchstens einmal pro Stunde (der Takt ist kurz)
            const metaDue = !onlyMissing
                && (opts.force || Date.now() - this._lastMetaCheck >= 60 * 60 * 1000);
            if (metaDue)
                this._lastMetaCheck = Date.now();

            const updatePromise = updateEnabled && metaDue
                ? this._updateChecker.checkForUpdates(updateUrl, this._cancellable)
                : Promise.resolve(null);

            // Versender-Datenbank: reine Daten, wirkt sofort (kein Ab-/Anmelden nötig)
            const shipperPromise = this._settings.get_boolean('shipper-db-auto-update') && metaDue
                ? updateShippers(this._settings.get_string('shipper-db-url'), this._cancellable)
                : Promise.resolve(null);

            let hint = null;
            let offline = false;
            let fetched = false;

            // Je Sendung eine Kette von Status-Anbietern (Einstellung „Status-Quelle“):
            // Der erste kommt zuerst dran, kann er nicht antworten (z. B. Key fehlt oder wird
            // abgelehnt), springt der nächste ein.
            const sources = parseCarrierSources(this._settings.get_string('carrier-sources'));
            const pending = parcels.filter(p => this._needsFetch(p, { onlyMissing, force: !!opts.force }));
            const chains = new Map(pending.map(p => [p.id,
                providerChain(getCarrier(p.carrier), sources[p.carrier] ?? 'auto')
                    .filter(id => this._providers[id])]));
            const unresolved = new Set(pending.filter(p => chains.get(p.id).length > 0).map(p => p.id));
            const hintFor = new Map();
            const notFoundIds = new Set();
            const steps = Math.max(0, ...[...chains.values()].map(c => c.length));

            for (let step = 0; step < steps && !offline; step++) {
                const byProvider = new Map();
                for (const p of pending) {
                    const providerId = unresolved.has(p.id) ? chains.get(p.id)[step] : null;
                    if (!providerId)
                        continue;
                    if (!byProvider.has(providerId))
                        byProvider.set(providerId, []);
                    byProvider.get(providerId).push(p);
                }

                for (const [providerId, targets] of byProvider) {
                    const result = await this._fetchProvider(providerId, targets);
                    offline = offline || result.offline;
                    fetched = true;
                    for (const id of result.resolved)
                        unresolved.delete(id);
                    for (const id of result.notFound)
                        notFoundIds.add(id);
                    if (result.hint) {
                        for (const t of targets) {
                            // Der Hinweis des zuerst versuchten Anbieters zählt
                            if (!result.resolved.has(t.id) && !hintFor.has(t.id))
                                hintFor.set(t.id, result.hint);
                        }
                    }
                    if (offline)
                        break;
                }
            }
            // Von keinem Anbieter gefunden → „Noch keine Daten“ (ein guter älterer Stand bleibt)
            for (const id of unresolved) {
                if (notFoundIds.has(id) && !this._cache[id]?.source && this._cache[id]?.state !== 'delivered') {
                    this._cache[id] = {
                        state: 'unknown',
                        statusText: 'Noch keine Daten',
                        detail: 'Die Sendung ist beim Versender (noch) nicht bekannt',
                        fetchedAt: Date.now(),
                    };
                }
            }
            // Hinweis nur für Sendungen, die am Ende von keinem Anbieter beantwortet wurden
            for (const id of unresolved) {
                hint = hint ?? hintFor.get(id) ?? null;
            }
            if (!this._settings || !this._indicator)
                return;

            // Ohne Abfrage (nichts fällig) bleiben Hinweis und Stand unverändert
            if (fetched) {
                this._hint = hint;
                this._isOffline = offline;
                if (!offline)
                    this._lastTimestamp = new Date();
            }

            if (fetched || opts.force || onlyMissing)
                this._saveCache(parcels);

            const updateStatus = await updatePromise;
            if (updateStatus)
                this._lastUpdateStatus = updateStatus;

            const shipperResult = await shipperPromise;
            if (shipperResult?.status === 'updated') {
                console.log(`[packetbar] Versender-Datenbank auf v${shipperResult.remoteVersion} aktualisiert.`);
                // Zähler hochsetzen: lädt die Datenbank neu (siehe Signal oben) und lässt eine
                // geöffnete Einstellungsseite ihre Versenderliste neu aufbauen.
                this._settings.set_int('shipper-db-revision', this._settings.get_int('shipper-db-revision') + 1);
            }

            if (offline)
                this._scheduleRetry(120);
            else if (this._followUpAt) {
                // Neu bei 17TRACK registriert → nach 90 s noch einmal abfragen, statt eine Stunde zu warten
                this._followUpAt = 0;
                this._scheduleRetry(90);
            }
        } catch (e) {
            console.warn(`[packetbar] Error in refreshData: ${e.message}`);
            this._isOffline = true;
            this._scheduleRetry(120);
        } finally {
            this._refreshing = false;
        }

        this._checkNotifications();
        this._applyDataToUI();

        if (this._pendingRefresh) {
            const full = this._pendingFull;
            this._pendingRefresh = false;
            this._pendingFull = false;
            this.refreshData({ onlyMissing: !full });
        }
    }

    _applyDataToUI() {
        if (!this._indicator || !this._settings)
            return;

        this._indicator.updateUI({
            parcels: parseParcels(this._settings.get_string('parcels')),
            cache: this._cache,
            hint: this._hint,
            isOffline: this._isOffline,
            lastTimestamp: this._lastTimestamp,
            updateStatus: this._lastUpdateStatus,
            requestsToday: this._requestsToday(),
        });
    }
}
