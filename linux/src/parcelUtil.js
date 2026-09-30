/**
 * parcelUtil.js - Reine Logik (ohne GNOME-Abhängigkeiten): Versender-Register,
 * Sendungsliste, Normalisierung der DHL-Antwort, Datums-Formatierung.
 */

import { CARRIERS } from './shippers.js';

// Die Versender kommen aus der Versender-Datenbank (data/shippers.json), siehe shippers.js.
export { CARRIERS, carrierIds, getCarrier } from './shippers.js';

export const STATE_LABELS = {
    preTransit: 'Angekündigt',
    transit: 'Unterwegs',
    delivered: 'Zugestellt',
    failure: 'Zustellproblem',
    unknown: 'Unbekannt',
};

// ---------------------------------------------------------------------------
// Sendungsliste (als JSON in GSettings)
// ---------------------------------------------------------------------------

/**
 * Liest die Sendungsliste aus dem JSON-String der Einstellungen. Ungültige
 * Einträge werden verworfen, das Ergebnis ist immer ein Array.
 * @param {string} json
 * @returns {{id: string, carrier: string, number: string, label: string}[]}
 */
export function parseParcels(json) {
    let data;
    try {
        data = JSON.parse(json || '[]');
    } catch (_e) {
        return [];
    }
    if (!Array.isArray(data))
        return [];

    const seen = new Set();
    const result = [];
    for (const item of data) {
        if (!item || typeof item !== 'object')
            continue;
        const carrier = String(item.carrier ?? '');
        const number = normalizeNumber(item.number);
        // Versender-IDs, die (noch) nicht in der Datenbank stehen, bleiben erhalten –
        // sonst würden Sendungen bei einem Datenbank-Update stillschweigend verschwinden.
        if (!/^[a-z0-9-]{2,20}$/.test(carrier) || !number)
            continue;
        const id = String(item.id || makeId(carrier, number));
        if (seen.has(id))
            continue;
        seen.add(id);
        result.push({ id, carrier, number, label: String(item.label ?? '').trim() });
    }
    return result;
}

export function serializeParcels(parcels) {
    return JSON.stringify(parcels.map(p => ({
        id: p.id, carrier: p.carrier, number: p.number, label: p.label ?? '',
    })));
}

export function normalizeNumber(value) {
    return String(value ?? '').replace(/\s+/g, '').trim();
}

/**
 * Prüft eine Sendungsnummer grob. Gibt eine Fehlermeldung oder null zurück.
 */
export function validateNumber(number) {
    if (!number)
        return 'Bitte eine Sendungsnummer eingeben';
    if (number.length < 6 || number.length > 40)
        return 'Die Sendungsnummer muss 6 bis 40 Zeichen lang sein';
    if (!/^[A-Za-z0-9._-]+$/.test(number))
        return 'Nur Buchstaben, Ziffern sowie . _ - sind erlaubt';
    return null;
}

export function makeId(carrier, number) {
    return `${carrier}:${number.toUpperCase()}`;
}

/**
 * Neue Sendung anlegen. Wirft bei ungültiger Nummer.
 */
export function makeParcel(carrier, rawNumber, label = '') {
    const number = normalizeNumber(rawNumber);
    const error = validateNumber(number);
    if (error)
        throw new Error(error);
    if (!CARRIERS[carrier])
        throw new Error(`Unbekannter Versender: ${carrier}`);
    return { id: makeId(carrier, number), carrier, number, label: String(label ?? '').trim() };
}

export function parseCache(json) {
    try {
        const data = JSON.parse(json || '{}');
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (_e) {
        return {};
    }
}

/**
 * Zugestellte Sendungen nach `hideAfterDays` Tagen ausblenden (0 = nie).
 */
export function isVisible(entry, hideAfterDays, now = Date.now()) {
    if (!entry || entry.state !== 'delivered' || !hideAfterDays)
        return true;
    const since = entry.timestampMs ?? entry.fetchedAt ?? now;
    return now - since <= hideAfterDays * 86400000;
}

/**
 * Hängt einen Zeitstempel an eine URL, damit ein Zwischenspeicher (bei raw.githubusercontent.com
 * bis zu etwa 5 Minuten) nicht die alte Fassung liefert. Der Header `Cache-Control: no-cache`
 * im Request reicht dafür nicht.
 */
export function withCacheBuster(url, now = Date.now()) {
    const base = String(url).trim().split('#')[0];
    return `${base}${base.includes('?') ? '&' : '?'}cb=${now}`;
}

/** Auswahl für das Abfrageintervall je Versender (Minuten). */
export const INTERVAL_CHOICES = [15, 30, 60, 120, 180, 240];

/**
 * Einstellung „Abfrageintervall je Versender“ (JSON in GSettings) lesen:
 * `{dhl: 15, dpd: 180}`. Ungültige Einträge werden verworfen.
 */
export function parseCarrierIntervals(json) {
    let data;
    try {
        data = JSON.parse(json || '{}');
    } catch (_e) {
        return {};
    }
    const result = {};
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return result;
    for (const [carrier, minutes] of Object.entries(data)) {
        if (/^[a-z0-9-]{2,20}$/.test(carrier) && INTERVAL_CHOICES.includes(minutes))
            result[carrier] = minutes;
    }
    return result;
}

/**
 * Ist eine Sendung wieder zur Abfrage fällig? Zugestellte nie. Als Bezugspunkt zählt der
 * letzte Versuch (auch ein fehlgeschlagener), damit ein abgelehnter Key nicht bei jedem
 * Takt neu angefragt wird. Frisch bei 17TRACK registrierte Sendungen sind nach 60 s dran.
 *
 * @param {{entry?: object, attemptAt?: number, intervalMin: number, now?: number}} args
 */
export function isDue({ entry, attemptAt = 0, intervalMin, now = Date.now() }) {
    if (entry?.state === 'delivered')
        return false;
    const last = Math.max(entry?.fetchedAt ?? 0, attemptAt);
    const waitMs = entry?.registered ? 60 * 1000 : intervalMin * 60 * 1000;
    return now - last >= waitMs;
}

/**
 * Noch nicht zugestellt = zählt im Panel als „unterwegs“.
 */
export function isActive(entry) {
    return entry?.state !== 'delivered';
}

// ---------------------------------------------------------------------------
// DHL: Antwort der Shipment Tracking Unified API normalisieren
// ---------------------------------------------------------------------------

const DHL_STATE = {
    'pre-transit': 'preTransit',
    'transit': 'transit',
    'delivered': 'delivered',
    'failure': 'failure',
    'unknown': 'unknown',
};

/**
 * @param {object} data - geparste JSON-Antwort von GET /track/shipments
 * @returns {{ok: true, state: string, statusText: string, detail: string,
 *            location: string, timestampMs: number|null, eta: string}
 *          | {ok: false, error: string, message: string}}
 */
export function normalizeDhlResponse(data) {
    const shipment = data?.shipments?.[0];
    if (!shipment)
        return { ok: false, error: 'notfound', message: 'Keine Sendung in der Antwort' };

    const status = shipment.status ?? {};
    const lastEvent = Array.isArray(shipment.events) ? shipment.events[0] : null;
    const state = DHL_STATE[String(status.statusCode ?? '').toLowerCase()] ?? 'unknown';

    const statusText = String(status.status || status.description || STATE_LABELS[state]);
    const rawDetail = String(status.description || lastEvent?.description || '');
    const detail = rawDetail === statusText ? '' : rawDetail;

    const address = status.location?.address ?? lastEvent?.location?.address ?? {};
    const location = String(address.addressLocality ?? '');

    const timestamp = status.timestamp ?? lastEvent?.timestamp ?? null;
    const timestampMs = timestamp ? Date.parse(timestamp) : NaN;

    return {
        ok: true,
        state,
        statusText,
        detail,
        location,
        timestampMs: Number.isNaN(timestampMs) ? null : timestampMs,
        eta: String(shipment.estimatedTimeOfDelivery ?? ''),
    };
}

/**
 * HTTP-Status der DHL-API in einen Fehlercode übersetzen.
 */
export function dhlHttpError(status) {
    switch (status) {
    case 401:
    case 403:
        return { ok: false, error: 'auth', message: 'API-Key ungültig oder nicht freigeschaltet' };
    case 404:
        return { ok: false, error: 'notfound', message: 'Sendung nicht gefunden' };
    case 429:
        return { ok: false, error: 'ratelimit', message: 'Anfragelimit der DHL-API erreicht' };
    default:
        return { ok: false, error: 'http', message: `HTTP ${status}` };
    }
}

// ---------------------------------------------------------------------------
// 17TRACK: Antworten der Tracking-API (v2.4) normalisieren
// ---------------------------------------------------------------------------

const TRACK17_STATE = {
    NotFound: ['unknown', 'Noch keine Daten'],
    InfoReceived: ['preTransit', 'Angekündigt'],
    InTransit: ['transit', 'Unterwegs'],
    Expired: ['unknown', 'Keine Updates mehr'],
    AvailableForPickup: ['transit', 'Abholbereit'],
    OutForDelivery: ['transit', 'In Zustellung'],
    DeliveryFailure: ['failure', 'Zustellung fehlgeschlagen'],
    Delivered: ['delivered', 'Zugestellt'],
    Exception: ['failure', 'Zustellproblem'],
};

/**
 * Fehlercodes aus `rejected[].error.code` (register / gettrackinfo).
 */
export const TRACK17_CODES = {
    INVALID_FORMAT: -18010012,
    INVALID_DATA: -18010013,
    ALREADY_REGISTERED: -18019901,
    NOT_REGISTERED: -18019902,
    CARRIER_UNDETECTED: -18019903,
    DAILY_LIMIT: -18019907,
    QUOTA_EXHAUSTED: -18019908,
};

/**
 * Antwort von POST /gettrackinfo → Status. Die Feldnamen folgen der 17TRACK-Doku
 * (track_info.latest_status / latest_event / time_metrics); fehlende Felder werden
 * toleriert, weil nicht jeder Versender alles liefert.
 *
 * @param {object} accepted - ein Element aus `data.accepted`
 */
export function normalizeTrack17Info(accepted) {
    const info = accepted?.track_info ?? {};
    const latestStatus = info.latest_status ?? {};
    const latestEvent = info.latest_event ?? {};

    const [state, label] = TRACK17_STATE[String(latestStatus.status ?? '')] ?? ['unknown', STATE_LABELS.unknown];

    const description = String(latestEvent.description ?? '').trim();
    const rawLocation = latestEvent.location;
    const location = typeof rawLocation === 'string' ? rawLocation.trim() : '';

    const timestamp = latestEvent.time_iso ?? latestEvent.time_utc ?? null;
    const timestampMs = timestamp ? Date.parse(timestamp) : NaN;

    const eta = info.time_metrics?.estimated_delivery_date ?? {};

    return {
        ok: true,
        state,
        statusText: label,
        detail: description === label ? '' : description,
        location,
        timestampMs: Number.isNaN(timestampMs) ? null : timestampMs,
        eta: String(eta.from ?? eta.to ?? ''),
    };
}

/**
 * Fehlerantwort aus einer `rejected[].error`-Angabe bzw. einem HTTP-Status.
 */
export function track17Error({ httpStatus = 200, code = 0, message = '' } = {}) {
    if (httpStatus === 401 || httpStatus === 403)
        return { ok: false, error: 'auth', message: 'API-Key ungültig' };
    if (httpStatus === 429)
        return { ok: false, error: 'ratelimit', message: 'Anfragelimit der 17TRACK-API erreicht' };
    if (httpStatus !== 200)
        return { ok: false, error: 'http', message: `HTTP ${httpStatus}` };

    switch (code) {
    case TRACK17_CODES.QUOTA_EXHAUSTED:
    case TRACK17_CODES.DAILY_LIMIT:
        return { ok: false, error: 'quota', message: 'Kontingent bei 17TRACK aufgebraucht' };
    case TRACK17_CODES.INVALID_FORMAT:
    case TRACK17_CODES.INVALID_DATA:
    case TRACK17_CODES.CARRIER_UNDETECTED:
        return { ok: false, error: 'notfound', message: message || 'Sendungsnummer nicht erkannt' };
    default:
        return { ok: false, error: 'http', message: message || `Fehlercode ${code}` };
    }
}

/**
 * Ganze Antwort von /gettrackinfo auswerten. `{ok:false, notRegistered:true}` heißt:
 * Die Nummer muss erst per /register angelegt werden.
 */
export function parseTrack17TrackInfo(httpStatus, body, number) {
    if (httpStatus !== 200 || !body || typeof body !== 'object')
        return track17Error({ httpStatus });
    if (body.code !== 0)
        return track17Error({ code: body.code });

    const accepted = body.data?.accepted;
    const item = Array.isArray(accepted)
        ? (accepted.find(a => a?.number === number) ?? accepted[0])
        : null;
    if (item)
        return normalizeTrack17Info(item);

    const rejected = body.data?.rejected?.[0]?.error;
    if (rejected?.code === TRACK17_CODES.NOT_REGISTERED)
        return { ok: false, notRegistered: true };
    return track17Error({ code: rejected?.code ?? -1, message: rejected?.message });
}

/** Antwort von /register auswerten. */
export function parseTrack17Register(httpStatus, body) {
    if (httpStatus !== 200 || !body || typeof body !== 'object')
        return track17Error({ httpStatus });
    if (body.code !== 0)
        return track17Error({ code: body.code });

    if (body.data?.accepted?.length)
        return { ok: true };
    const rejected = body.data?.rejected?.[0]?.error;
    // Schon angelegt (z. B. durch einen parallelen Aufruf) ist kein Fehler
    if (rejected?.code === TRACK17_CODES.ALREADY_REGISTERED)
        return { ok: true };
    return track17Error({ code: rejected?.code ?? -1, message: rejected?.message });
}

// ---------------------------------------------------------------------------
// Formatierung
// ---------------------------------------------------------------------------

const WEEKDAYS = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];
const pad = n => String(n).padStart(2, '0');

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Voraussichtliche Zustellung als „heute“, „morgen“ oder „Do., 02.10.“.
 * Die Uhrzeit wird bewusst weggelassen (DHL liefert meist nur das Datum).
 */
export function formatEta(iso, now = new Date()) {
    if (!iso)
        return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return '';
    const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
    if (diff === 0)
        return 'heute';
    if (diff === 1)
        return 'morgen';
    if (diff === -1)
        return 'gestern';
    return `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
}

/**
 * Zeitpunkt eines Ereignisses als „30.09. 10:05“.
 */
export function formatDateTime(ms) {
    if (ms === null || ms === undefined)
        return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime()))
        return '';
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Tag für das Anfrage-Budget (lokales Datum, YYYY-MM-DD).
 */
export function dayKey(now = new Date()) {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
