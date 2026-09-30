/**
 * Tests für die reine Logik (ohne GNOME). Ausführen mit:  node tests/run.mjs
 *
 * Prüft u. a. die mitgelieferte Versender-Datenbank – nach jeder Änderung an
 * linux/data/shippers.json einmal laufen lassen.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as u from '../linux/src/parcelUtil.js';
import * as sh from '../linux/src/shippers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let count = 0;
const test = (name, fn) => {
    try {
        fn();
        count++;
    } catch (e) {
        console.error(`FEHLER in „${name}“:\n${e.stack}`);
        process.exit(1);
    }
};

// ---------------------------------------------------------------------------
// Versender-Datenbank
// ---------------------------------------------------------------------------

const bundledRaw = JSON.parse(readFileSync(join(root, 'linux/data/shippers.json'), 'utf-8'));

test('mitgelieferte Datenbank ist vollständig gültig (nichts übersprungen)', () => {
    const r = sh.validateShipperDb(bundledRaw);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.skipped, 0, 'Die mitgelieferte Datenbank enthält ungültige Einträge');
    assert.equal(r.db.shippers.length, bundledRaw.shippers.length);
    assert.ok(r.db.version >= 1);
});

test('mitgelieferte Datenbank: DHL hat die Status-API, alle Links sind https', () => {
    const r = sh.validateShipperDb(bundledRaw);
    const byId = Object.fromEntries(r.db.shippers.map(s => [s.id, s]));
    assert.equal(byId.dhl.provider, 'dhl');
    for (const id of ['ups', 'dpd', 'gls', 'amazon'])
        assert.equal(byId[id].provider, null, id);
    for (const s of r.db.shippers)
        assert.ok(s.trackUrl.startsWith('https://'), s.id);
});

test('Registry wird angewendet und ist sofort überall sichtbar', () => {
    sh.applyShippers(sh.validateShipperDb(bundledRaw).db);
    assert.deepEqual(sh.carrierIds(), ['dhl', 'ups', 'dpd', 'gls', 'amazon']);
    assert.equal(u.CARRIERS, sh.CARRIERS);   // dasselbe Objekt, wird in-place aktualisiert
    assert.equal(u.getCarrier('dhl').api, true);
    assert.equal(u.getCarrier('ups').api, false);
    assert.match(u.getCarrier('dhl').url('0034 x'), /piececode=0034%20x$/);
    assert.equal(sh.activeShipperVersion(), bundledRaw.version);
});

test('unbekannter Versender liefert Platzhalter ohne Link', () => {
    const c = u.getCarrier('gibtsnicht');
    assert.equal(c.unknown, true);
    assert.equal(c.url('123456'), null);
    assert.equal(c.api, false);
});

const base = () => ({
    schema: 1, version: 5, updated: '2026-10-01',
    shippers: [{ id: 'hermes', name: 'Hermes', trackUrl: 'https://example.org/t/{number}' }],
});

test('gültige Datenbank wird bereinigt übernommen', () => {
    const r = sh.validateShipperDb({ ...base(), evil: '<script>' });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.db).sort(), ['schema', 'shippers', 'updated', 'version']);
    assert.deepEqual(Object.keys(r.db.shippers[0]).sort(),
        ['id', 'name', 'numberHint', 'provider', 'trackUrl']);
});

test('Strukturfehler lehnen die ganze Datenbank ab', () => {
    for (const bad of [null, [], 'x', {}, { schema: 1 }, { ...base(), version: 'x' },
        { ...base(), version: -1 }, { ...base(), shippers: [] }, { ...base(), shippers: 'x' },
        { ...base(), schema: 0 }])
        assert.equal(sh.validateShipperDb(bad).ok, false, JSON.stringify(bad));
});

test('zu neues Schema wird abgelehnt (alte Extension versteht es nicht)', () => {
    const r = sh.validateShipperDb({ ...base(), schema: 2 });
    assert.equal(r.ok, false);
    assert.match(r.error, /neuere packetbar-Version/);
});

test('ungültige Einträge werden einzeln übersprungen, gültige bleiben', () => {
    const data = base();
    data.shippers.push(
        { id: 'BAD ID', name: 'x', trackUrl: 'https://a.b/{number}' },        // ID
        { id: 'http-only', name: 'x', trackUrl: 'http://a.b/{number}' },      // kein https
        { id: 'js', name: 'x', trackUrl: 'javascript:alert(1)' },             // Schema
        { id: 'file', name: 'x', trackUrl: 'file:///etc/passwd' },
        { id: 'spaces', name: 'x', trackUrl: 'https://a.b/ {number}' },       // Leerraum
        { id: 'noname', name: '', trackUrl: 'https://a.b/{number}' },
        { id: 'ctrl', name: 'a\nb', trackUrl: 'https://a.b/{number}' },       // Steuerzeichen
        { id: 'hermes', name: 'Doppelt', trackUrl: 'https://a.b/{number}' },  // doppelt
        null, 42, 'text');
    const r = sh.validateShipperDb(data);
    assert.equal(r.ok, true);
    assert.equal(r.db.shippers.length, 1);
    assert.equal(r.db.shippers[0].name, 'Hermes');
    assert.equal(r.skipped, 11);
});

test('nur ungültige Einträge → Datenbank abgelehnt', () => {
    const r = sh.validateShipperDb({ schema: 1, version: 2, shippers: [{ id: 'x' }] });
    assert.equal(r.ok, false);
});

test('unbekannter provider wird zu „nur Link“ (kein Fehler, keine Code-Ausführung)', () => {
    const data = base();
    data.shippers[0].provider = 'ups-api-v9';
    data.shippers.push({ id: 'evil', name: 'Evil', provider: '__proto__', trackUrl: 'https://a.b/{number}' });
    const r = sh.validateShipperDb(data);
    assert.equal(r.ok, true);
    assert.equal(r.db.shippers[0].provider, null);
    assert.equal(r.db.shippers[1].provider, null);
});

test('die Datenbank kann keinen API-Endpunkt oder Schlüsselbund-Namen festlegen', () => {
    const data = base();
    Object.assign(data.shippers[0], {
        provider: 'dhl', endpoint: 'https://evil.example/steal', secret: 'other-key', apiUrl: 'https://evil.example',
    });
    const s = sh.validateShipperDb(data).db.shippers[0];
    assert.equal(s.provider, 'dhl');
    for (const key of ['endpoint', 'secret', 'apiUrl'])
        assert.equal(key in s, false, key);
});

test('Nummer wird im Link URL-kodiert (kein Einschleusen weiterer Parameter)', () => {
    assert.equal(sh.renderTrackUrl('https://a.b/t?n={number}', 'x&y=1#z'), 'https://a.b/t?n=x%26y%3D1%23z');
    assert.equal(sh.renderTrackUrl('https://a.b/orders', '123456'), 'https://a.b/orders');
    assert.equal(sh.renderTrackUrl('https://a.b/{number}/{number}', 'A1'), 'https://a.b/A1/A1');
});

test('Versionsvergleich', () => {
    assert.equal(sh.isNewerVersion(2, 1), true);
    assert.equal(sh.isNewerVersion(1, 1), false);
    assert.equal(sh.isNewerVersion(0, 1), false);
    assert.equal(sh.isNewerVersion('9', 1), false);
    assert.equal(sh.isNewerVersion(null, 1), false);
});

test('Datenbank-Update ersetzt die Registry; entfernter Versender behält seine Sendungen', () => {
    sh.applyShippers(sh.validateShipperDb(bundledRaw).db);
    const parcel = u.makeParcel('ups', 'TESTNUMMER1', 'Test');

    sh.applyShippers(sh.validateShipperDb(base()).db);   // UPS gibt es jetzt nicht mehr
    assert.deepEqual(sh.carrierIds(), ['hermes']);
    assert.equal(sh.activeShipperVersion(), 5);

    const list = u.parseParcels(u.serializeParcels([parcel]));
    assert.equal(list.length, 1, 'Sendung darf nicht verschwinden');
    assert.equal(list[0].carrier, 'ups');
    assert.equal(u.getCarrier('ups').unknown, true);
    assert.throws(() => u.makeParcel('ups', 'NEUENUMMER1'), /Unbekannter Versender/);

    sh.applyShippers(sh.validateShipperDb(bundledRaw).db);   // zurück
});

// ---------------------------------------------------------------------------
// Sendungsliste, DHL-Antworten, Formatierung
// ---------------------------------------------------------------------------

test('DHL-Antwort wird normalisiert', () => {
    const transit = u.normalizeDhlResponse({ shipments: [{
        id: '00340434161094042557', service: 'parcel-de',
        status: {
            timestamp: '2026-09-30T10:05:00', statusCode: 'transit',
            status: 'Die Sendung wurde im Zustellfahrzeug einsortiert.',
            description: 'Die Sendung wurde im Zustellfahrzeug einsortiert.',
            location: { address: { addressLocality: 'Krefeld' } },
        },
        estimatedTimeOfDelivery: '2026-09-30T23:59:59', events: [],
    }] });
    assert.equal(transit.ok, true);
    assert.equal(transit.state, 'transit');
    assert.equal(transit.location, 'Krefeld');
    assert.equal(transit.detail, '');
    assert.ok(transit.timestampMs > 0);

    const delivered = u.normalizeDhlResponse({ shipments: [{ status: {
        statusCode: 'delivered', status: 'Zugestellt', description: 'Die Sendung wurde zugestellt.',
        timestamp: '2026-09-30T12:00:00' } }] });
    assert.equal(delivered.state, 'delivered');
    assert.equal(delivered.detail, 'Die Sendung wurde zugestellt.');

    assert.equal(u.normalizeDhlResponse({ shipments: [{ status: { statusCode: 'pre-transit' } }] }).state, 'preTransit');
    assert.equal(u.normalizeDhlResponse({ shipments: [{ status: { statusCode: '???' } }] }).state, 'unknown');
    assert.equal(u.normalizeDhlResponse({}).error, 'notfound');
    assert.equal(u.normalizeDhlResponse(null).ok, false);
});

test('DHL-HTTP-Fehler', () => {
    for (const [status, error] of [[401, 'auth'], [403, 'auth'], [404, 'notfound'], [429, 'ratelimit'], [500, 'http']])
        assert.equal(u.dhlHttpError(status).error, error);
});

test('Sendungsliste: Parsen, Serialisieren, Validieren', () => {
    assert.deepEqual(u.parseParcels('kaputt'), []);
    assert.deepEqual(u.parseParcels('{}'), []);
    const p = u.makeParcel('dhl', ' 0034 0434 1610 ', 'Kopfhörer');
    assert.equal(p.number, '003404341610');
    assert.equal(p.id, 'dhl:003404341610');
    const list = u.parseParcels(u.serializeParcels([p, p, { carrier: 'Foo Bar!', number: '123456' }]));
    assert.equal(list.length, 1);
    assert.throws(() => u.makeParcel('dhl', 'abc'));
    assert.throws(() => u.makeParcel('dhl', '12345 67$'));
    assert.throws(() => u.makeParcel('xyz', '1234567'));
    assert.notEqual(u.validateNumber('A'.repeat(41)), null);
});

test('Sichtbarkeit und aktive Sendungen', () => {
    const now = Date.now();
    assert.equal(u.isVisible({ state: 'delivered', timestampMs: now - 4 * 86400000 }, 3, now), false);
    assert.equal(u.isVisible({ state: 'delivered', timestampMs: now - 2 * 86400000 }, 3, now), true);
    assert.equal(u.isVisible({ state: 'delivered', timestampMs: now - 99 * 86400000 }, 0, now), true);
    assert.equal(u.isVisible({ state: 'transit' }, 3, now), true);
    assert.equal(u.isActive({ state: 'delivered' }), false);
    assert.equal(u.isActive(undefined), true);
});

test('Formatierung', () => {
    const n = new Date(2026, 8, 30, 9, 0);
    assert.equal(u.formatEta('2026-09-30T23:59:59', n), 'heute');
    assert.equal(u.formatEta('2026-10-01T23:59:59', n), 'morgen');
    assert.equal(u.formatEta('2026-10-02T00:00:00', n), 'Fr. 02.10.');
    assert.equal(u.formatEta('', n), '');
    assert.equal(u.formatEta('müll', n), '');
    assert.equal(u.formatDateTime(new Date(2026, 8, 30, 10, 5).getTime()), '30.09. 10:05');
    assert.equal(u.dayKey(n), '2026-09-30');
    assert.deepEqual(u.parseCache('nope'), {});
});

console.log(`${count} Tests bestanden`);
