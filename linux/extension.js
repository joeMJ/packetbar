/**
 * extension.js - Haupteinstiegspunkt für packetbar (GNOME 46 - 50)
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { PacketIndicator } from './src/indicator.js';
import { DhlClient } from './src/dhlClient.js';
import { UpdateChecker } from './src/updater.js';
import { lookupSecretNoPrompt } from './src/secretStore.js';
import { parseParcels, parseCache, dayKey, getCarrier } from './src/parcelUtil.js';
import { loadShippers, updateShippers } from './src/shipperDb.js';

// DHL erlaubt standardmäßig 250 Anfragen/Tag und 1 Anfrage/Sekunde.
const DAILY_LIMIT = 240;          // Sicherheitsabstand zum Tageslimit
const REQUEST_GAP_MS = 1300;      // Abstand zwischen zwei Anfragen (Spike Arrest)
const RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
const MANUAL_REFRESH_GAP_MS = 30 * 1000;

export default class PacketBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();

        // Status-Anbieter: Client und Schlüsselbund-Eintrag sind bewusst fest im Code und
        // nicht Teil der Versender-Datenbank – diese verweist nur per `provider` darauf.
        this._providers = {
            dhl: { client: new DhlClient(), secret: 'dhl-api-key' },
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
        this._pausedUntil = 0;

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

    _restartTimer() {
        this._clearSource('_timeoutId');

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._intervalMinutes() * 60,
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
            if (data.day === dayKey() && Number.isFinite(data.count))
                return { day: data.day, count: data.count };
        } catch (_e) {
            // ungültig → neu beginnen
        }
        return { day: dayKey(), count: 0 };
    }

    _countRequest() {
        const today = dayKey();
        if (this._budget.day !== today)
            this._budget = { day: today, count: 0 };
        this._budget.count++;
        this._settings?.set_string('request-budget', JSON.stringify(this._budget));
    }

    _budgetLeft() {
        if (this._budget.day !== dayKey())
            this._budget = { day: dayKey(), count: 0 };
        return DAILY_LIMIT - this._budget.count;
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

    _needsFetch(parcel, { onlyMissing }) {
        const entry = this._cache[parcel.id];
        if (entry?.state === 'delivered')
            return false;          // zugestellte Sendungen nie erneut abfragen
        if (onlyMissing)
            return !entry;
        return true;
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
     * @returns {Promise<{hint: object|null, offline: boolean}>}
     */
    async _fetchProvider(providerId, targets) {
        const { client, secret: secretName } = this._providers[providerId];

        const { value: apiKey, locked } = await this._getSecret(secretName);
        if (!apiKey) {
            if (locked)
                this._scheduleRetry(60);   // ohne Dialog warten, bis der Schlüsselbund entsperrt ist
            return { hint: { kind: locked ? 'locked' : 'nokey' }, offline: false };
        }

        if (Date.now() < this._pausedUntil)
            return { hint: { kind: 'ratelimit' }, offline: false };

        let hint = null;
        let offline = false;

        for (let i = 0; i < targets.length; i++) {
            if (!this._cancellable || this._cancellable.is_cancelled())
                break;

            if (this._budgetLeft() <= 0) {
                hint = { kind: 'budget' };
                break;
            }

            const parcel = targets[i];
            const res = await client.fetchShipment(apiKey, parcel.number, this._cancellable);
            if (res.error === 'cancelled')
                break;
            if (res.error !== 'network')
                this._countRequest();

            if (res.ok) {
                this._cache[parcel.id] = { ...res, fetchedAt: Date.now() };
            } else if (res.error === 'notfound') {
                this._cache[parcel.id] = {
                    state: 'unknown',
                    statusText: 'Noch keine Daten',
                    detail: 'Die Sendung ist beim Versender (noch) nicht bekannt',
                    fetchedAt: Date.now(),
                };
            } else if (res.error === 'auth') {
                hint = { kind: 'auth' };
                break;                     // Key falsch – keine weiteren Anfragen verschwenden
            } else if (res.error === 'ratelimit') {
                this._pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
                hint = { kind: 'ratelimit' };
                break;
            } else if (res.error === 'network') {
                offline = true;
                break;
            }
            // Andere HTTP-Fehler: alten Stand behalten, nächste Sendung versuchen

            if (i < targets.length - 1)
                await this._sleep(REQUEST_GAP_MS);
        }

        return { hint, offline };
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

            const updatePromise = updateEnabled && !onlyMissing
                ? this._updateChecker.checkForUpdates(updateUrl, this._cancellable)
                : Promise.resolve(null);

            // Versender-Datenbank: reine Daten, wirkt sofort (kein Ab-/Anmelden nötig)
            const shipperPromise = this._settings.get_boolean('shipper-db-auto-update') && !onlyMissing
                ? updateShippers(this._settings.get_string('shipper-db-url'), this._cancellable)
                : Promise.resolve(null);

            let hint = null;
            let offline = false;
            let fetched = false;

            for (const providerId of Object.keys(this._providers)) {
                const targets = parcels.filter(p =>
                    getCarrier(p.carrier).provider === providerId && this._needsFetch(p, { onlyMissing }));
                if (targets.length === 0)
                    continue;

                const result = await this._fetchProvider(providerId, targets);
                hint = hint ?? result.hint;
                offline = offline || result.offline;
                fetched = true;
            }
            if (!this._settings || !this._indicator)
                return;

            this._hint = hint;
            this._isOffline = offline;
            if (fetched && !offline)
                this._lastTimestamp = new Date();

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
        } catch (e) {
            console.warn(`[packetbar] Error in refreshData: ${e.message}`);
            this._isOffline = true;
            this._scheduleRetry(120);
        } finally {
            this._refreshing = false;
        }

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
            requestsToday: this._budget.day === dayKey() ? this._budget.count : 0,
        });
    }
}
