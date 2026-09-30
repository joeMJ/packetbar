#!/usr/bin/env bash
# update.sh - Standalone Update via Git für packetbar
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/install.sh" --update "$@"
