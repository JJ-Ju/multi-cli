#!/usr/bin/env bash
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd -- "$(dirname "${SCRIPT_SOURCE}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
START_BIN="${REPO_ROOT}/start.sh"

if [[ ! -x "${START_BIN}" ]]; then
  printf 'Error: start script not found at %s\n' "${START_BIN}" >&2
  exit 1
fi

CURRENT_SHELL="${SHELL:-}"
if [[ -z "${CURRENT_SHELL}" ]]; then
  printf 'Error: SHELL is not set. Run this from within your shell so it can detect where to write the alias.\n' >&2
  exit 1
fi

SHELL_NAME="$(basename "${CURRENT_SHELL}")"
case "${SHELL_NAME}" in
  bash|zsh)
    RC_FILE="${HOME}/.${SHELL_NAME}rc"
    if [[ ! -f "${RC_FILE}" ]]; then
      printf 'Creating %s\n' "${RC_FILE}"
      touch "${RC_FILE}"
    fi
    if grep -q "alias ionesco=" "${RC_FILE}"; then
      printf 'An ionesco alias already exists in %s\n' "${RC_FILE}"
      exit 0
    fi
    printf "alias ionesco='%s'\n" "${START_BIN}" >> "${RC_FILE}"
    printf 'Alias added to %s. Reload your shell with: source %s\n' "${RC_FILE}" "${RC_FILE}"
    ;;
  fish)
    CONFIG="${HOME}/.config/fish/config.fish"
    if [[ ! -f "${CONFIG}" ]]; then
      printf 'Creating %s\n' "${CONFIG}"
      mkdir -p "$(dirname "${CONFIG}")"
      touch "${CONFIG}"
    fi
    if grep -q "alias ionesco" "${CONFIG}"; then
      printf 'An ionesco alias already exists in %s\n' "${CONFIG}"
      exit 0
    fi
    printf "alias ionesco '%s'\n" "${START_BIN}" >> "${CONFIG}"
    printf 'Alias added to %s. Run: source %s\n' "${CONFIG}" "${CONFIG}"
    ;;
  *)
    printf 'Unsupported shell (%s). Add this line to your shell init file manually:\n  alias ionesco=\"%s\"\n' "${CURRENT_SHELL}" "${START_BIN}"
    ;;
esac
