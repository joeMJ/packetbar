/**
 * dhlClient.js - DHL Shipment Tracking (Unified) API
 *
 * GET https://api-eu.dhl.com/track/shipments?trackingNumber=…
 * Header: DHL-API-Key
 * Standard-Limit: 250 Anfragen/Tag, 1 Anfrage/Sekunde (HTTP 429 bei Überschreitung).
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { normalizeDhlResponse, dhlHttpError } from './parcelUtil.js';

try {
    Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
} catch (e) {
    // Bereits promisified
}

const ENDPOINT = 'https://api-eu.dhl.com/track/shipments';

export class DhlClient {
    constructor() {
        this._session = new Soup.Session({
            timeout: 15,
            user_agent: 'packetbar-gnome-extension',
        });
    }

    /**
     * Fragt den Status einer Sendung ab. Wirft nie – Fehler kommen als
     * `{ok: false, error, message}` zurück (error: auth | notfound | ratelimit |
     * http | network | cancelled).
     *
     * @param {string} apiKey
     * @param {string} trackingNumber
     * @param {Gio.Cancellable} [cancellable=null]
     */
    async fetchShipment(apiKey, trackingNumber, cancellable = null) {
        const url = `${ENDPOINT}?trackingNumber=${encodeURIComponent(trackingNumber)}&language=de`;

        try {
            const message = new Soup.Message({
                method: 'GET',
                uri: GLib.Uri.parse(url, GLib.UriFlags.NONE),
            });
            message.request_headers.append('DHL-API-Key', apiKey);
            message.request_headers.append('Accept', 'application/json');

            const bytes = await this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, cancellable);

            const status = message.get_status();
            if (status !== Soup.Status.OK)
                return dhlHttpError(status);

            const text = new TextDecoder('utf-8').decode(bytes.toArray());
            return normalizeDhlResponse(JSON.parse(text));
        } catch (e) {
            if (cancellable?.is_cancelled())
                return { ok: false, error: 'cancelled', message: 'Abgebrochen' };
            console.warn(`[packetbar] DHL-Abfrage fehlgeschlagen: ${e.message}`);
            return { ok: false, error: 'network', message: e.message };
        }
    }
}
