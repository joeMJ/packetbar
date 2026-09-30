/**
 * track17Client.js - 17TRACK Tracking API v2.4 (ein Key für viele Versender)
 *
 * POST https://api.17track.net/track/v2.4/{register|gettrackinfo}
 * Header: 17token, Content-Type: application/json
 *
 * Ablauf: Erst /gettrackinfo. Ist die Nummer dort noch nicht registriert
 * (Fehler -18019902), wird sie einmalig per /register angelegt – das kostet 1 Kontingent
 * (kostenlos: 100 pro Monat). Weitere Statusabfragen kosten kein Kontingent.
 * Limit: 3 Anfragen pro Sekunde (HTTP 429 bei Überschreitung).
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { parseTrack17TrackInfo, parseTrack17Register } from './parcelUtil.js';

try {
    Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
} catch (e) {
    // Bereits promisified
}

const BASE = 'https://api.17track.net/track/v2.4';

export class Track17Client {
    constructor() {
        this._session = new Soup.Session({
            timeout: 15,
            user_agent: 'packetbar-gnome-extension',
        });
    }

    /**
     * Ruft einen Endpunkt auf. Wirft nie: `{httpStatus, body}` oder `{error}`.
     */
    async _post(apiKey, endpoint, payload, cancellable) {
        const message = new Soup.Message({
            method: 'POST',
            uri: GLib.Uri.parse(`${BASE}/${endpoint}`, GLib.UriFlags.NONE),
        });
        message.request_headers.append('17token', apiKey);
        message.request_headers.append('Accept', 'application/json');
        message.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload))));

        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable);

        const httpStatus = message.get_status();
        let body = null;
        try {
            body = JSON.parse(new TextDecoder('utf-8').decode(bytes.toArray()));
        } catch (_e) {
            // kein JSON (z. B. Fehlerseite) – wird über httpStatus gemeldet
        }
        return { httpStatus, body };
    }

    /**
     * Fragt den Status einer Sendung ab. Der Versender wird von 17TRACK automatisch erkannt.
     * `requests` ist die Zahl der tatsächlich gesendeten Anfragen (für das Tageslimit).
     *
     * @param {string} apiKey
     * @param {string} number
     * @param {Gio.Cancellable} [cancellable=null]
     * @param {{carrier?: number}} [options] fester 17TRACK-Versendercode (z. B. 7041 = DHL Paket),
     *   für Nummern, bei denen die automatische Erkennung nichts findet
     */
    async fetchShipment(apiKey, number, cancellable = null, options = {}) {
        let requests = 0;
        const item = Number.isInteger(options?.carrier) ? { number, carrier: options.carrier } : { number };
        try {
            let res = await this._post(apiKey, 'gettrackinfo', [item], cancellable);
            requests++;
            let parsed = this._parse(res, number);

            if (parsed.notRegistered) {
                const reg = await this._post(apiKey, 'register', [item], cancellable);
                requests++;
                const regParsed = this._parseRegister(reg);
                if (!regParsed.ok)
                    return { ...regParsed, requests };

                // Erste Daten liefert 17TRACK laut Doku erst nach ca. einer Minute.
                return {
                    ok: true,
                    state: 'preTransit',
                    statusText: 'Registriert',
                    detail: 'Warte auf die ersten Daten des Versenders',
                    location: '',
                    timestampMs: null,
                    eta: '',
                    registered: true,
                    requests,
                };
            }

            return { ...parsed, requests };
        } catch (e) {
            if (cancellable?.is_cancelled())
                return { ok: false, error: 'cancelled', message: 'Abgebrochen', requests };
            console.warn(`[packetbar] 17TRACK-Abfrage fehlgeschlagen: ${e.message}`);
            return { ok: false, error: 'network', message: e.message, requests };
        }
    }

    _parse(res, number) {
        const parsed = parseTrack17TrackInfo(res.httpStatus, res.body, number);
        if (parsed.ok && parsed.state === 'unknown') {
            // Zur Fehlersuche: nur Feldnamen und Statuswert, keine Inhalte der Sendung
            const item = res.body?.data?.accepted?.[0] ?? {};
            const info = item.track_info ?? {};
            console.log(`[packetbar] 17TRACK ohne auswertbaren Status: Felder=${Object.keys(item)} `
                + `track_info=${Object.keys(info)} status=${JSON.stringify(info.latest_status?.status)}`);
        }
        return parsed;
    }

    _parseRegister(res) {
        return parseTrack17Register(res.httpStatus, res.body);
    }
}
