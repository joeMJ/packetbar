#!/usr/bin/env bash
# ==============================================================================
# packetbar - Multi-Platform Entrypoint
#
# Lokal (im Klon):  ./install.sh [--install|--update|--uninstall|--help]
#                   → delegiert an linux/install.sh
# Per curl:         curl -fsSL https://raw.githubusercontent.com/joeMJ/packetbar/main/install.sh | bash
#                   curl -fsSL … | bash -s -- --uninstall
#                   → lädt den aktuellen Stand von GitHub (HTTPS) in ein
#                     temporäres Verzeichnis und installiert von dort.
# ==============================================================================
set -euo pipefail

# Alles in einer Funktion, damit bash bei "curl | bash" das komplette Skript
# gelesen hat, bevor etwas ausgeführt wird.
main() {
    local tarball="${PACKETBAR_TARBALL:-https://github.com/joeMJ/packetbar/archive/refs/heads/main.tar.gz}"
    local script_dir=""

    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
        script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    fi

    # Lokaler Klon
    if [ -n "${script_dir}" ] && [ -f "${script_dir}/linux/install.sh" ]; then
        exec "${script_dir}/linux/install.sh" "$@"
    fi

    # Per curl: von GitHub laden
    local cmd
    for cmd in curl tar; do
        if ! command -v "${cmd}" &>/dev/null; then
            echo -e "\033[1;31m[FEHLER]\033[0m ${cmd} ist nicht installiert." >&2
            exit 1
        fi
    done

    PACKETBAR_TMP="$(mktemp -d)"
    trap 'rm -rf "${PACKETBAR_TMP:-}"' EXIT
    local tmp="${PACKETBAR_TMP}"

    echo -e "\033[1;34m[INFO]\033[0m Lade packetbar von GitHub..."
    if ! curl -fsSL "${tarball}" | tar -xz -C "${tmp}" --strip-components=1; then
        echo -e "\033[1;31m[FEHLER]\033[0m Download von ${tarball} fehlgeschlagen. Netzwerkverbindung prüfen." >&2
        exit 1
    fi

    if [ ! -f "${tmp}/linux/install.sh" ]; then
        echo -e "\033[1;31m[FEHLER]\033[0m Download unvollständig: linux/install.sh fehlt." >&2
        exit 1
    fi

    bash "${tmp}/linux/install.sh" "$@"
}

main "$@"
