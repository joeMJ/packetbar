/**
 * shipperDb.js - Versender-Datenbank laden, aktualisieren und speichern
 *
 * Zwei Quellen, die neuere Version gewinnt:
 *   1. mitgeliefert:  <Extension>/data/shippers.json (wird bei jedem Update ersetzt)
 *   2. heruntergeladen: ~/.local/share/packetbar/shippers.json
 *
 * Die heruntergeladene Datei liegt bewusst außerhalb des Extension-Ordners: Sie
 * übersteht Updates und Neuinstallationen, und ein Datenbank-Update wirkt sofort –
 * ohne Ab- und Anmelden, denn GNOME Shell lädt nur JavaScript-Code nicht neu.
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    validateShipperDb, applyShippers, activeShipperVersion, activeShipperUpdated,
    carrierIds, isNewerVersion,
} from './shippers.js';
import { withCacheBuster } from './parcelUtil.js';

try {
    Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
} catch (e) {
    // Bereits promisified
}

const MAX_BODY_BYTES = 256 * 1024;

const USER_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'packetbar']);
const USER_FILE = GLib.build_filenamev([USER_DIR, 'shippers.json']);

let session = null;

function readValidated(path) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        if (!ok)
            return null;
        const result = validateShipperDb(JSON.parse(new TextDecoder('utf-8').decode(contents)));
        if (!result.ok) {
            console.warn(`[packetbar] ${path}: ${result.error}`);
            return null;
        }
        return result.db;
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn(`[packetbar] ${path} nicht lesbar: ${e.message}`);
        return null;
    }
}

/**
 * Lädt die neuere der beiden Dateien und macht sie zur aktiven Registry.
 *
 * @param {string} extensionPath - Ordner der Extension (this.path)
 * @returns {{version: number, updated: string, source: string, count: number}}
 */
export function loadShippers(extensionPath) {
    const bundled = readValidated(GLib.build_filenamev([extensionPath, 'data', 'shippers.json']));
    const user = readValidated(USER_FILE);

    let db = null;
    let source = 'fallback';
    if (bundled && user)
        [db, source] = user.version > bundled.version ? [user, 'heruntergeladen'] : [bundled, 'mitgeliefert'];
    else if (user)
        [db, source] = [user, 'heruntergeladen'];
    else if (bundled)
        [db, source] = [bundled, 'mitgeliefert'];

    if (db)
        applyShippers(db);

    return shipperInfo(source);
}

/** Beschreibung der aktiven Datenbank (Version, Stand, Anzahl, Quelle). */
export function shipperInfo(source = '') {
    return {
        version: activeShipperVersion(),
        updated: activeShipperUpdated(),
        count: carrierIds().length,
        source,
    };
}

function saveUserShippers(db) {
    GLib.mkdir_with_parents(USER_DIR, 0o700);
    // Bereinigte Kopie speichern, nicht den rohen Download
    const text = JSON.stringify(db, null, 2);
    Gio.File.new_for_path(USER_FILE).replace_contents(
        new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

/**
 * Lädt die Datenbank von der konfigurierten URL und übernimmt sie, wenn sie neuer
 * ist als die aktive. Wirft nie.
 *
 * @param {string} url - HTTPS-URL der shippers.json
 * @param {Gio.Cancellable} [cancellable=null]
 * @returns {Promise<{status: 'updated'|'current'|'error', localVersion: number,
 *                    remoteVersion: number|null, error: string|null, skipped: number}>}
 */
export async function updateShippers(url, cancellable = null) {
    const localVersion = activeShipperVersion();
    const fail = error => ({ status: 'error', localVersion, remoteVersion: null, error, skipped: 0 });

    const trimmed = (url ?? '').trim();
    if (!trimmed.startsWith('https://'))
        return fail('Die Update-URL der Versender-Datenbank muss mit https:// beginnen');

    try {
        session ??= new Soup.Session({ timeout: 10, user_agent: 'packetbar-gnome-extension' });

        const message = new Soup.Message({
            method: 'GET',
            uri: GLib.Uri.parse(withCacheBuster(trimmed), GLib.UriFlags.ENCODED),
        });
        message.request_headers.append('Cache-Control', 'no-cache');

        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);

        const status = message.get_status();
        if (status !== Soup.Status.OK)
            return fail(`HTTP ${status} beim Abruf der Versender-Datenbank`);
        if (bytes.get_size() > MAX_BODY_BYTES)
            return fail('Die Versender-Datenbank ist unerwartet groß');

        const result = validateShipperDb(JSON.parse(new TextDecoder('utf-8').decode(bytes.toArray())));
        if (!result.ok)
            return fail(result.error);

        const remoteVersion = result.db.version;
        if (!isNewerVersion(remoteVersion, localVersion))
            return { status: 'current', localVersion, remoteVersion, error: null, skipped: result.skipped };

        saveUserShippers(result.db);
        applyShippers(result.db);
        return { status: 'updated', localVersion, remoteVersion, error: null, skipped: result.skipped };
    } catch (e) {
        if (!cancellable?.is_cancelled())
            console.warn(`[packetbar] Versender-Datenbank konnte nicht aktualisiert werden: ${e.message}`);
        return fail(e.message);
    }
}
