#!/usr/bin/env bash
# ==============================================================================
# packetbar - Multi-Platform Entrypoint
# Delegiert auf Linux an linux/uninstall.sh
# ==============================================================================
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "${SCRIPT_DIR}/linux/uninstall.sh" ]; then
    exec "${SCRIPT_DIR}/linux/uninstall.sh" "$@"
else
    echo -e "\033[1;31m[FEHLER]\033[0m linux/uninstall.sh nicht gefunden!" >&2
    exit 1
fi
