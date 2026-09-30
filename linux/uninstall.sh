#!/usr/bin/env bash
# uninstall.sh - Standalone Deinstallation für packetbar
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/install.sh" --uninstall "$@"
