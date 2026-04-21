#!/usr/bin/env bash
# ClaudeClaw deployment script — git pull, bun install, restart systemd service.
# Run on VPS: bash deploy/deploy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="claudeclaw"

# Detect Bun path dynamically
BUN_PATH="$(command -v bun 2>/dev/null || echo "")"
if [[ -z "$BUN_PATH" ]]; then
  for candidate in "$HOME/.bun/bin/bun" "/usr/local/bin/bun" "/opt/bun/bin/bun"; do
    if [[ -x "$candidate" ]]; then
      BUN_PATH="$candidate"
      break
    fi
  done
fi

if [[ -z "$BUN_PATH" ]]; then
  echo "ERROR: Bun not found. Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

echo "=== ClaudeClaw Deploy ==="
echo "Project: $PROJECT_DIR"
echo "Bun:     $BUN_PATH"
echo ""

cd "$PROJECT_DIR"

# Pull latest code
echo ">>> git pull"
git pull --ff-only

# Install dependencies
echo ">>> bun install"
"$BUN_PATH" install --frozen-lockfile

# Install/update systemd service — template paths into the unit file
SYSTEMD_DIR="$HOME/.config/systemd/user"
echo ">>> Installing systemd service"
mkdir -p "$SYSTEMD_DIR"
for unit in claudeclaw.service claudeclaw-update.service; do
  sed -e "s|__HOME__|$HOME|g" \
      -e "s|__PROJECT__|$PROJECT_DIR|g" \
      -e "s|__BUN__|$BUN_PATH|g" \
      "deploy/$unit" > "$SYSTEMD_DIR/$unit"
done
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"

# Restart service
echo ">>> Restarting $SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

# Show status
sleep 1
systemctl --user status "$SERVICE_NAME" --no-pager || true

echo ""
echo "=== Deploy complete ==="
echo "Logs: journalctl --user -u $SERVICE_NAME -f"
