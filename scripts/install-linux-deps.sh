#!/usr/bin/env bash
set -euo pipefail

# Installs the required system libraries to run VS Code/Electron in headless Linux.
# Supports Ubuntu 24.04 (t64 packages) and older variants when available.

if ! command -v apt-get >/dev/null 2>&1; then
  echo "[deps] apt-get not found; skip this step or install the libraries manually." >&2
  exit 0
fi

echo "[deps] Updating APT indexes..."
sudo apt-get update -y

pick_pkg() {
  local a="$1" b="$2"
  local cand
  cand=$(apt-cache policy "$a" 2>/dev/null | awk '/Candidate:/ {print $2}') || true
  if [[ -n "${cand:-}" && "${cand}" != "(none)" ]]; then
    echo "$a"
    return 0
  fi
  cand=$(apt-cache policy "$b" 2>/dev/null | awk '/Candidate:/ {print $2}') || true
  if [[ -n "${cand:-}" && "${cand}" != "(none)" ]]; then
    echo "$b"
    return 0
  fi
  # none available
  return 1
}

TO_INSTALL=(
  # Pairs (non-t64, t64)
  "$(pick_pkg libatk-bridge2.0-0 libatk-bridge2.0-0t64 || true)"
  "$(pick_pkg libgtk-3-0 libgtk-3-0t64 || true)"
  "$(pick_pkg libasound2 libasound2t64 || true)"
  "$(pick_pkg libcups2 libcups2t64 || true)"
)

# Packages that typically keep the same name across Ubuntu versions
STATIC=(
  libnss3
  libx11-xcb1
  libxss1
  libxtst6
  libdrm2
  libgbm1
  libxshmfence1
  libxcb-dri3-0
  libxcb-dri2-0
  libxdamage1
  libxrandr2
  libxfixes3
  libxcomposite1
  libpango-1.0-0
  libpangocairo-1.0-0
)

# Filter out empty entries (when no variant is available)
FILTERED=()
for p in "${TO_INSTALL[@]}"; do
  [[ -n "${p}" ]] && FILTERED+=("${p}")
done

echo "[deps] Installing packages: ${FILTERED[*]} ${STATIC[*]}"
sudo apt-get install -y "${FILTERED[@]}" "${STATIC[@]}" || {
  echo "[deps] Failed to install some libraries. Check package names for your distro." >&2
  exit 1
}

echo "[deps] Libraries installed successfully."
