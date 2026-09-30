/**
 * shippers.js - Versender-Datenbank (reine Logik, ohne GNOME-Abhängigkeiten)
 *
 * Die Datenbank ist eine JSON-Datei (linux/data/shippers.json) mit Versender-
 * Vorlagen: Name, Link zur Sendungsverfolgung und – optional – der Verweis auf
 * einen im Code vorhandenen Status-Anbieter (`provider`).
 *
 * SICHERHEIT: Die Datenbank enthält ausschließlich Daten. API-Endpunkte und
 * Schlüsselbund-Einträge sind fest im Code hinterlegt, `provider` verweist nur
 * darauf. Eine manipulierte Datenbank kann daher keine API-Keys an fremde
 * Server umleiten. Links müssen mit https:// beginnen.
 */

/** Höchstes Datenbank-Schema, das diese Version der Extension versteht. */
export const SCHEMA_VERSION = 1;

/** Status-Anbieter, für die der Code einen Client mitbringt. */
export const PROVIDERS = ['dhl'];

const ID_PATTERN = /^[a-z0-9-]{2,20}$/;
const MAX_SHIPPERS = 50;

/**
 * Laufende Versender-Registry. Wird von applyShippers() in-place aktualisiert,
 * damit alle Module, die sie importieren, sofort den neuen Stand sehen.
 */
export const CARRIERS = {};

let activeVersion = 0;
let activeUpdated = '';

/** Notfall-Datenbank, falls weder die mitgelieferte noch eine geladene Datei lesbar ist. */
const FALLBACK_DB = {
    schema: SCHEMA_VERSION,
    version: 0,
    shippers: [{
        id: 'dhl',
        name: 'DHL',
        provider: 'dhl',
        trackUrl: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode={number}',
    }],
};

function isText(value, max) {
    return typeof value === 'string' && value.length >= 1 && value.length <= max
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateShipper(item) {
    if (!item || typeof item !== 'object')
        return null;
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id))
        return null;
    if (!isText(item.name, 30))
        return null;
    if (!isText(item.trackUrl, 300) || !item.trackUrl.startsWith('https://') || /\s/.test(item.trackUrl))
        return null;

    const hint = item.numberHint;
    return {
        id: item.id,
        name: item.name.trim(),
        trackUrl: item.trackUrl,
        // Unbekannter Anbieter (z. B. aus einem neueren Schema) → nur Link, kein Fehler
        provider: PROVIDERS.includes(item.provider) ? item.provider : null,
        numberHint: isText(hint, 160) ? hint : '',
    };
}

/**
 * Prüft eine geladene Datenbank und gibt eine bereinigte Kopie zurück.
 * Einzelne ungültige Einträge werden übersprungen (`skipped`), die Datenbank
 * als Ganzes wird nur bei Strukturfehlern oder zu neuem Schema abgelehnt.
 *
 * @param {any} data
 * @returns {{ok: true, db: object, skipped: number} | {ok: false, error: string}}
 */
export function validateShipperDb(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return { ok: false, error: 'Keine gültige Versender-Datenbank' };

    if (!Number.isInteger(data.schema) || data.schema < 1)
        return { ok: false, error: 'Schema-Version fehlt' };
    if (data.schema > SCHEMA_VERSION)
        return { ok: false, error: `Die Datenbank benötigt eine neuere packetbar-Version (Schema ${data.schema})` };
    if (!Number.isInteger(data.version) || data.version < 0)
        return { ok: false, error: 'Versionsnummer fehlt' };
    if (!Array.isArray(data.shippers) || data.shippers.length === 0 || data.shippers.length > MAX_SHIPPERS)
        return { ok: false, error: 'Liste der Versender fehlt oder ist zu groß' };

    const seen = new Set();
    const shippers = [];
    let skipped = 0;
    for (const item of data.shippers) {
        const shipper = validateShipper(item);
        if (!shipper || seen.has(shipper.id)) {
            skipped++;
            continue;
        }
        seen.add(shipper.id);
        shippers.push(shipper);
    }
    if (shippers.length === 0)
        return { ok: false, error: 'Kein gültiger Versender in der Datenbank' };

    return {
        ok: true,
        skipped,
        db: {
            schema: data.schema,
            version: data.version,
            updated: isText(data.updated, 20) ? data.updated : '',
            shippers,
        },
    };
}

/**
 * Setzt den Link zusammen: `{number}` wird durch die URL-kodierte Sendungsnummer ersetzt.
 */
export function renderTrackUrl(template, number) {
    return template.split('{number}').join(encodeURIComponent(number));
}

/**
 * Macht die (bereits validierte) Datenbank zur aktiven Registry.
 */
export function applyShippers(db) {
    for (const id of Object.keys(CARRIERS))
        delete CARRIERS[id];

    for (const s of db.shippers) {
        CARRIERS[s.id] = {
            id: s.id,
            name: s.name,
            provider: s.provider,
            api: s.provider !== null,
            numberHint: s.numberHint,
            trackUrl: s.trackUrl,
            url: number => renderTrackUrl(s.trackUrl, number),
        };
    }
    activeVersion = db.version;
    activeUpdated = db.updated ?? '';
}

/** Version der gerade aktiven Datenbank. */
export function activeShipperVersion() {
    return activeVersion;
}

export function activeShipperUpdated() {
    return activeUpdated;
}

/** Liste der Versender-IDs in Reihenfolge der Datenbank. */
export function carrierIds() {
    return Object.keys(CARRIERS);
}

/**
 * Versender zu einer ID. Gibt für unbekannte IDs (z. B. ein aus der Datenbank
 * entfernter Versender) einen Platzhalter zurück, damit eingetragene Sendungen
 * nicht verloren gehen.
 */
export function getCarrier(id) {
    return CARRIERS[id] ?? {
        id,
        name: id,
        provider: null,
        api: false,
        numberHint: '',
        trackUrl: '',
        unknown: true,
        url: () => null,
    };
}

/** true, wenn die Datenbank `candidate` neuer ist als `current`. */
export function isNewerVersion(candidate, current) {
    return Number.isInteger(candidate) && candidate > current;
}

// Beim Laden des Moduls ist die Registry nie leer.
applyShippers(validateShipperDb(FALLBACK_DB).db);
