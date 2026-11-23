#!/bin/sh
# herdr-router installer: clone (or update), install, and link `hroute` / `hsub` into ~/.local/bin.
#   curl -fsSL https://raw.githubusercontent.com/Manulapo/herdr-router/main/install.sh | sh
# It does not touch your Claude Code settings; run `hroute setup --yes` for that.
set -eu

REPO="${HROUTER_REPO:-https://github.com/Manulapo/herdr-router}"
DIR="${HROUTER_DIR:-$HOME/.local/share/herdr-router}"
BIN="${HROUTER_BIN:-$HOME/.local/bin}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "herdr-router: '$1' is required. $2" >&2; exit 1; }; }
need git "Install git first."
need bun "Install Bun: https://bun.sh"

if [ -d "$DIR/.git" ]; then
  echo "Updating $DIR"
  git -C "$DIR" pull --ff-only --quiet
else
  echo "Cloning into $DIR"
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi

(cd "$DIR" && bun install --silent)

mkdir -p "$BIN"
for n in hroute hsub; do
  ln -sf "$DIR/bin/$n.ts" "$BIN/$n"
done

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add $BIN to your PATH to use hroute." ;;
esac

echo
echo "Installed. Next:"
echo "  hroute setup          # preview what it would configure"
echo "  hroute setup --yes    # apply (config, .env, Claude hooks, subagents)"
echo "  hroute doctor"
