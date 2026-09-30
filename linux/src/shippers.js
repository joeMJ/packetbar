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
export const PROVIDERS = ['dhl', '17track'];

const ID_PATTERN = /^[a-z0-9-]{2,20}$/;
const MAX_SHIPPERS = 50;

/** Zustände, auf die sich alle Anbieter-Status abbilden lassen. */
export const STATES = ['preTransit', 'transit', 'delivered', 'failure', 'unknown'];

const MIN_INTERVAL = 15;       // darunter würden die Tageslimits der APIs leiden
const MAX_INTERVAL = 1440;

/**
 * Übersetzung der Status-Werte je Anbieter → Zustand, Text und „wird heute zugestellt“.
 * Eingebaute Vorgabe; die Versender-Datenbank kann Einträge ergänzen oder ersetzen, ohne dass
 * neuer Programmcode nötig ist.
 */
const DEFAULT_STATUS_MAPS = {
    '17track': {
        NotFound: { state: 'unknown', label: 'Noch keine Daten' },
        InfoReceived: { state: 'preTransit', label: 'Angekündigt' },
        InTransit: { state: 'transit', label: 'Unterwegs' },
        Expired: { state: 'unknown', label: 'Keine Updates mehr' },
        AvailableForPickup: { state: 'transit', label: 'Abholbereit' },
        OutForDelivery: { state: 'transit', label: 'In Zustellung', today: true },
        DeliveryFailure: { state: 'failure', label: 'Zustellung fehlgeschlagen' },
        Delivered: { state: 'delivered', label: 'Zugestellt' },
        Exception: { state: 'failure', label: 'Zustellproblem' },
    },
    dhl: {
        'pre-transit': { state: 'preTransit' },
        'transit': { state: 'transit' },
        'delivered': { state: 'delivered' },
        'failure': { state: 'failure' },
        'unknown': { state: 'unknown' },
    },
};

const DEFAULT_INTERVAL_CHOICES = [15, 30, 60, 120, 180, 240];

let activeStatusMaps = cloneMaps(DEFAULT_STATUS_MAPS);
let activeIntervalChoices = [...DEFAULT_INTERVAL_CHOICES];

function cloneMaps(maps) {
    const out = {};
    for (const [provider, map] of Object.entries(maps))
        out[provider] = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { ...v }]));
    return out;
}

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

/**
 * Nummernmuster sind bewusst stark eingeschränkt: keine Gruppen, keine Alternativen (`|`),
 * keine Rückverweise. Dann sind sie in linearer Zeit auswertbar, und eine manipulierte
 * Datenbank kann die Oberfläche nicht mit einem katastrophalen Muster einfrieren.
 * Mehrere Formate werden als Liste angegeben.
 */
const PATTERN_CHARS = /^[\^$\[\]\-A-Za-z0-9{},+*?]{1,80}$/;
const MAX_PATTERNS = 8;

function compilePattern(pattern) {
    if (typeof pattern !== 'string' || !PATTERN_CHARS.test(pattern))
        return null;
    try {
        return new RegExp(`^(?:${pattern})$`, 'i');
    } catch (_e) {
        return null;
    }
}

function validInterval(value) {
    return Number.isInteger(value) && value >= MIN_INTERVAL && value <= MAX_INTERVAL ? value : null;
}

function validateStatusMaps(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return out;
    for (const provider of PROVIDERS) {
        const map = raw[provider];
        if (!map || typeof map !== 'object' || Array.isArray(map))
            continue;
        const clean = {};
        for (const [key, entry] of Object.entries(map).slice(0, 60)) {
            if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || !entry || typeof entry !== 'object')
                continue;
            if (!STATES.includes(entry.state))
                continue;
            const value = { state: entry.state };
            if (isText(entry.label, 40))
                value.label = entry.label.trim();
            if (entry.today === true)
                value.today = true;
            clean[key] = value;
        }
        if (Object.keys(clean).length > 0)
            out[provider] = clean;
    }
    return out;
}

function validateIntervalChoices(raw) {
    if (!Array.isArray(raw))
        return null;
    const choices = [...new Set(raw.map(validInterval).filter(v => v !== null))].sort((a, b) => a - b);
    return choices.length > 0 && choices.length <= 12 ? choices : null;
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

    // Status-Anbieter in Reihenfolge der Vorgabe. `providers` (Liste) hat Vorrang vor dem
    // älteren Einzelfeld `provider`. Unbekannte Anbieter (z. B. aus einem neueren Schema)
    // werden übergangen → im Zweifel nur Link, kein Fehler.
    const wanted = Array.isArray(item.providers) ? item.providers : [item.provider];
    const providers = [...new Set(wanted.filter(p => PROVIDERS.includes(p)))];

    // Feste Anbieter-Einstellungen je Versender, z. B. der 17TRACK-Versendercode. Nur Zahlen,
    // nur bekannte Anbieter – keine Adressen, keine Schlüssel.
    const providerOptions = {};
    if (item.providerOptions && typeof item.providerOptions === 'object' && !Array.isArray(item.providerOptions)) {
        for (const id of providers) {
            const code = item.providerOptions[id]?.carrier;
            if (Number.isInteger(code) && code > 0 && code < 1000000)
                providerOptions[id] = { carrier: code };
        }
    }

    const numberPatterns = (Array.isArray(item.numberPatterns) ? item.numberPatterns : [])
        .filter(p => compilePattern(p) !== null).slice(0, MAX_PATTERNS);

    const hint = item.numberHint;
    return {
        id: item.id,
        name: item.name.trim(),
        trackUrl: item.trackUrl,
        providers,
        provider: providers[0] ?? null,
        providerOptions,
        numberPatterns,
        minInterval: validInterval(item.minInterval),
        defaultInterval: validInterval(item.defaultInterval),
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
            statusMaps: validateStatusMaps(data.statusMaps),
            intervals: validateIntervalChoices(data.intervals),
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
            providers: s.providers,
            providerOptions: s.providerOptions,
            numberPatterns: s.numberPatterns,
            numberRegexes: s.numberPatterns.map(compilePattern),
            minInterval: s.minInterval,
            defaultInterval: s.defaultInterval,
            api: s.providers.length > 0,
            numberHint: s.numberHint,
            trackUrl: s.trackUrl,
            url: number => renderTrackUrl(s.trackUrl, number),
        };
    }
    // Status-Übersetzung: Vorgabe, Einträge der Datenbank ergänzen oder ersetzen sie
    activeStatusMaps = cloneMaps(DEFAULT_STATUS_MAPS);
    for (const [provider, map] of Object.entries(db.statusMaps ?? {}))
        Object.assign(activeStatusMaps[provider] ??= {}, cloneMaps({ x: map }).x);
    activeIntervalChoices = db.intervals ?? [...DEFAULT_INTERVAL_CHOICES];

    activeVersion = db.version;
    activeUpdated = db.updated ?? '';
}

/** Übersetzung eines Status-Werts: `{state, label?, today?}` oder null, wenn unbekannt. */
export function getStatusEntry(provider, key) {
    const map = activeStatusMaps[provider];
    return map && Object.hasOwn(map, key) ? map[key] : null;
}

/** Auswahl für das Abfrageintervall (Minuten), aus der Datenbank oder eingebaut. */
export function getIntervalChoices() {
    return [...activeIntervalChoices];
}

/**
 * Passt die Nummer zu einem der üblichen Formate des Versenders?
 * @returns {boolean|null} null, wenn der Versender keine Muster hinterlegt hat
 */
export function matchesNumber(carrier, number) {
    const regexes = (carrier?.numberRegexes ?? []).filter(Boolean);
    if (regexes.length === 0)
        return null;
    return regexes.some(r => r.test(number));
}

/** Versender-ID, wenn genau ein Versender zur Nummer passt, sonst null. */
export function detectCarrier(number) {
    const hits = Object.values(CARRIERS).filter(c => matchesNumber(c, number) === true);
    return hits.length === 1 ? hits[0].id : null;
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
        providers: [],
        providerOptions: {},
        numberPatterns: [],
        numberRegexes: [],
        minInterval: null,
        defaultInterval: null,
        api: false,
        numberHint: '',
        trackUrl: '',
        unknown: true,
        url: () => null,
    };
}

/**
 * Einstellung „Status-Quelle je Versender“ (JSON in GSettings) lesen:
 * `{ups: '17track', dhl: 'auto'}`. Ungültiges wird verworfen.
 */
export function parseCarrierSources(json) {
    let data;
    try {
        data = JSON.parse(json || '{}');
    } catch (_e) {
        return {};
    }
    const result = {};
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return result;
    for (const [carrier, choice] of Object.entries(data)) {
        if (ID_PATTERN.test(carrier) && (choice === 'auto' || PROVIDERS.includes(choice)))
            result[carrier] = choice;
    }
    return result;
}

/**
 * In welcher Reihenfolge Status-Anbieter für einen Versender versucht werden.
 * „auto“ (Standard) = alle möglichen Anbieter in Reihenfolge der Datenbank, mit
 * Ausweichen auf den nächsten, wenn einer nicht antworten kann (kein oder abgelehnter Key).
 * Eine feste Wahl nutzt nur diesen Anbieter.
 *
 * @param {{providers: string[]}} carrier
 * @param {string} [choice]
 * @returns {string[]}
 */
export function providerChain(carrier, choice = 'auto') {
    const all = carrier?.providers ?? [];
    return choice !== 'auto' && all.includes(choice) ? [choice] : all;
}

/** true, wenn die Datenbank `candidate` neuer ist als `current`. */
export function isNewerVersion(candidate, current) {
    return Number.isInteger(candidate) && candidate > current;
}

// Beim Laden des Moduls ist die Registry nie leer.
applyShippers(validateShipperDb(FALLBACK_DB).db);
