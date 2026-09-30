/**
 * parcelUtil.js - Reine Logik (ohne GNOME-Abhängigkeiten): Versender-Register,
 * Sendungsliste, Normalisierung der DHL-Antwort, Datums-Formatierung.
 */

/**
 * Versender-Register.
 *  api:    true = Status wird über eine Tracking-API abgefragt (braucht `secret`)
 *  secret: Name des Eintrags im GNOME-Schlüsselbund (siehe secretStore.js)
 *  url:    Link zur Sendungsverfolgung des Versenders (Karte anklicken)
 */
export const CARRIERS = {
    dhl: {
        name: 'DHL',
        api: true,
        secret: 'dhl-api-key',
        url: n => `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${encodeURIComponent(n)}`,
    },
    ups: {
        name: 'UPS',
        api: false,
        url: n => `https://www.ups.com/track?loc=de_DE&tracknum=${encodeURIComponent(n)}`,
    },
    dpd: {
        name: 'DPD',
        api: false,
        url: n => `https://tracking.dpd.de/parcelstatus?query=${encodeURIComponent(n)}&locale=de_DE`,
    },
    gls: {
        name: 'GLS',
        api: false,
        url: n => `https://gls-group.com/DE/de/paketverfolgung?match=${encodeURIComponent(n)}`,
    },
    amazon: {
        name: 'Amazon',
        api: false,
        url: () => 'https://www.amazon.de/gp/css/order-history',
    },
};

export const CARRIER_IDS = Object.keys(CARRIERS);

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
        if (!CARRIERS[carrier] || !number)
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
