/**
 * indicator.js - Panel Button & Popup-Menü UI für packetbar
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    CARRIERS, STATE_LABELS, isVisible, isActive, formatEta, formatDateTime,
} from './parcelUtil.js';

const STATE_ICONS = {
    preTransit: 'document-send-symbolic',
    transit: 'package-x-generic-symbolic',
    delivered: 'emblem-ok-symbolic',
    failure: 'dialog-warning-symbolic',
    unknown: 'dialog-question-symbolic',
};

const HINT_TEXTS = {
    locked: 'Schlüsselbund gesperrt – DHL wird abgefragt, sobald er entsperrt ist.',
    nokey: 'Kein DHL-API-Key hinterlegt – bitte in den Einstellungen eintragen.',
    auth: 'DHL lehnt den API-Key ab – bitte in den Einstellungen prüfen.',
    ratelimit: 'DHL-Anfragelimit erreicht – Abfragen pausieren eine Stunde.',
    budget: 'Tageslimit für DHL-Anfragen fast erreicht – morgen geht es weiter.',
};

export const PacketIndicator = GObject.registerClass(
class PacketIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'PacketBar Indicator', false);

        this._extension = extension;
        this._settings = extension.getSettings();

        // 1. Panel Box (Icon + Anzahl)
        this._panelBox = new St.BoxLayout({
            style_class: 'packetbar-panel-box',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelIcon = new St.Icon({
            icon_name: 'package-x-generic-symbolic',
            style_class: 'system-status-icon packetbar-panel-icon',
        });
        this._panelBox.add_child(this._panelIcon);

        this._panelLabel = new St.Label({
            text: '',
            style_class: 'packetbar-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._panelBox.add_child(this._panelLabel);

        this.add_child(this._panelBox);

        // 2. Popup Menü Aufbau
        this._buildMenu();
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('packetbar-menu');

        this._mainSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._mainSection);

        this._contentBox = new St.BoxLayout({
            vertical: true,
            style_class: 'packetbar-content-box',
        });
        this._mainSection.actor.add_child(this._contentBox);

        // Update-Banner (wird bei verfügbarem Update eingeblendet)
        this._updateBanner = new St.BoxLayout({
            style_class: 'packetbar-update-banner',
            visible: false,
        });
        this._updateBanner.add_child(new St.Icon({
            icon_name: 'software-update-available-symbolic',
            style_class: 'packetbar-update-icon',
        }));
        this._updateLabel = new St.Label({
            text: 'Update verfügbar!',
            style_class: 'packetbar-update-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._updateBanner.add_child(this._updateLabel);
        this._contentBox.add_child(this._updateBanner);

        // Hinweis-Banner (Schlüsselbund gesperrt, Key fehlt, Limit …)
        this._hintBanner = new St.BoxLayout({
            style_class: 'packetbar-hint-banner',
            visible: false,
        });
        this._hintBanner.add_child(new St.Icon({
            icon_name: 'dialog-information-symbolic',
            style_class: 'packetbar-hint-icon',
        }));
        this._hintLabel = new St.Label({
            text: '',
            style_class: 'packetbar-hint-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._hintLabel.clutter_text.line_wrap = true;
        this._hintLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._hintBanner.add_child(this._hintLabel);
        this._contentBox.add_child(this._hintBanner);

        // Titelzeile mit Zusammenfassung
        const titleBox = new St.BoxLayout({
            style_class: 'packetbar-section-title-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({
            text: 'Sendungen',
            style_class: 'packetbar-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        titleBox.add_child(title);
        this._summaryLabel = new St.Label({
            text: '',
            style_class: 'packetbar-section-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._summaryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        titleBox.add_child(this._summaryLabel);
        this._contentBox.add_child(titleBox);

        // Kartenliste
        this._listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'packetbar-list-box',
            x_expand: true,
        });
        this._contentBox.add_child(this._listBox);

        this._contentBox.add_child(new PopupMenu.PopupSeparatorMenuItem());

        // Footer (Stand & Buttons)
        this._footerBox = new St.BoxLayout({
            style_class: 'packetbar-footer-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._footerStatusLabel = new St.Label({
            text: 'Initialisiere...',
            style_class: 'packetbar-footer-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._footerBox.add_child(this._footerStatusLabel);

        const refreshBtn = new St.Button({
            style_class: 'packetbar-icon-button button',
            can_focus: true,
            child: new St.Icon({ icon_name: 'view-refresh-symbolic', icon_size: 16 }),
        });
        refreshBtn.connect('clicked', () => {
            this._footerStatusLabel.text = 'Aktualisiere...';
            this._extension.refreshData({ force: true, manual: true });
        });
        this._footerBox.add_child(refreshBtn);

        const settingsBtn = new St.Button({
            style_class: 'packetbar-icon-button button',
            can_focus: true,
            child: new St.Icon({ icon_name: 'emblem-system-symbolic', icon_size: 16 }),
        });
        settingsBtn.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        this._footerBox.add_child(settingsBtn);

        this._contentBox.add_child(this._footerBox);
    }

    /**
     * Karte einer Sendung. Ein Klick öffnet die Sendungsverfolgung des Versenders.
     */
    _buildCard(parcel, entry) {
        const carrier = CARRIERS[parcel.carrier];
        const state = entry?.state ?? 'unknown';
        const hasApi = carrier.api;

        const card = new St.Button({
            style_class: `packetbar-card packetbar-card-${hasApi && entry ? state : 'manual'}`,
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        card.connect('clicked', () => {
            this.menu.close();
            try {
                Gio.AppInfo.launch_default_for_uri(carrier.url(parcel.number), null);
            } catch (e) {
                console.warn(`[packetbar] Link konnte nicht geöffnet werden: ${e.message}`);
            }
        });

        const row = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'packetbar-card-row',
        });
        card.set_child(row);

        row.add_child(new St.Icon({
            icon_name: hasApi && entry ? STATE_ICONS[state] : 'package-x-generic-symbolic',
            icon_size: 28,
            style_class: 'packetbar-card-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const info = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'packetbar-card-info',
        });
        row.add_child(info);

        const title = new St.Label({
            text: parcel.label || parcel.number,
            style_class: 'packetbar-card-title',
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(title);

        const subtitle = new St.Label({
            text: parcel.label ? `${carrier.name} • ${parcel.number}` : carrier.name,
            style_class: 'packetbar-card-subtitle',
        });
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        info.add_child(subtitle);

        let statusText;
        let detailText = '';
        if (!hasApi) {
            statusText = 'Keine Status-API – Klick öffnet die Sendungsverfolgung';
        } else if (!entry) {
            statusText = 'Noch nicht abgefragt';
        } else {
            statusText = entry.statusText || STATE_LABELS[state];
            const parts = [];
            if (entry.detail)
                parts.push(entry.detail);
            const where = [entry.location, formatDateTime(entry.timestampMs)].filter(Boolean).join(', ');
            if (where)
                parts.push(where);
            detailText = parts.join(' • ');
        }

        const status = new St.Label({
            text: statusText,
            style_class: 'packetbar-card-status',
        });
        status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(status);

        if (detailText) {
            const detail = new St.Label({
                text: detailText,
                style_class: 'packetbar-card-detail',
            });
            detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            info.add_child(detail);
        }

        // Rechts: voraussichtliche Zustellung
        const eta = hasApi && entry && state !== 'delivered' ? formatEta(entry.eta) : '';
        if (eta) {
            const etaBox = new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'packetbar-card-eta-box',
            });
            etaBox.add_child(new St.Label({
                text: 'Zustellung',
                style_class: 'packetbar-card-eta-caption',
                x_align: Clutter.ActorAlign.END,
            }));
            etaBox.add_child(new St.Label({
                text: eta,
                style_class: 'packetbar-card-eta',
                x_align: Clutter.ActorAlign.END,
            }));
            row.add_child(etaBox);
        }

        return card;
    }

    /**
     * Aktualisiert die UI mit den neuesten Sendungsdaten.
     */
    updateUI({ parcels, cache, hint = null, isOffline = false, lastTimestamp = null,
        updateStatus = null, requestsToday = 0 }) {
        const hideDays = this._settings.get_int('hide-delivered-days');
        const visible = parcels.filter(p => isVisible(cache[p.id], hideDays));

        // Panel: Anzahl der Sendungen, die noch unterwegs sind
        const active = visible.filter(p => isActive(cache[p.id])).length;
        const hasProblem = visible.some(p => cache[p.id]?.state === 'failure');

        this._panelLabel.text = String(active);
        this._panelLabel.visible = active > 0;
        this._panelIcon.icon_name = hasProblem ? 'dialog-warning-symbolic' : 'package-x-generic-symbolic';
        if (hasProblem)
            this._panelBox.add_style_class_name('packetbar-panel-problem');
        else
            this._panelBox.remove_style_class_name('packetbar-panel-problem');

        // Zusammenfassung in der Titelzeile
        const delivered = visible.length - active;
        const summary = [];
        if (active > 0)
            summary.push(`${active} unterwegs`);
        if (delivered > 0)
            summary.push(`${delivered} zugestellt`);
        this._summaryLabel.text = summary.join(' • ');

        // Karten neu aufbauen: aktive zuerst (mit Zustellproblem ganz oben), dann zugestellte
        this._listBox.destroy_all_children();
        if (visible.length === 0) {
            this._listBox.add_child(new St.Label({
                text: parcels.length === 0
                    ? 'Keine Sendungen eingetragen – in den Einstellungen hinzufügen.'
                    : 'Keine aktuellen Sendungen.',
                style_class: 'packetbar-empty-placeholder',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        } else {
            const rank = p => {
                const e = cache[p.id];
                if (e?.state === 'failure') return 0;
                if (e?.state === 'delivered') return 3;
                if (e?.state === 'transit') return 1;
                return 2;
            };
            const sorted = [...visible].sort((a, b) => rank(a) - rank(b));
            for (const parcel of sorted)
                this._listBox.add_child(this._buildCard(parcel, cache[parcel.id]));
        }

        // Hinweis-Banner
        if (hint && HINT_TEXTS[hint.kind]) {
            this._hintLabel.text = HINT_TEXTS[hint.kind];
            this._hintBanner.visible = true;
        } else {
            this._hintBanner.visible = false;
        }

        // Footer Stand
        let statusMsg;
        if (lastTimestamp instanceof Date) {
            const hh = String(lastTimestamp.getHours()).padStart(2, '0');
            const mm = String(lastTimestamp.getMinutes()).padStart(2, '0');
            statusMsg = `Stand: ${hh}:${mm} Uhr`;
        } else {
            statusMsg = 'Stand: noch keine Abfrage';
        }
        if (isOffline)
            statusMsg += ' (Offline)';
        if (requestsToday > 0)
            statusMsg += ` • ${requestsToday} Abfragen heute`;
        this._footerStatusLabel.text = statusMsg;

        // Update-Banner
        if (updateStatus?.updateAvailable) {
            this._updateBanner.visible = true;
            this._updateLabel.text = `Update v${updateStatus.remoteVersionName ?? updateStatus.remoteVersion} verfügbar – „Jetzt aktualisieren“ in den Einstellungen`;
        } else {
            this._updateBanner.visible = false;
        }
    }
});
