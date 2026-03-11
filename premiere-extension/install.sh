#!/bin/bash
# Resonance — Premiere Pro Extension Installer
# Creates a symlink in Adobe's CEP extensions folder and enables debug mode.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_ID="com.resonance.premiere"
CEP_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"

echo "=== Resonance Premiere Pro Extension Installer ==="
echo ""

# Create CEP extensions directory if needed
mkdir -p "$CEP_DIR"

# Remove old symlink/folder if exists
if [ -e "$CEP_DIR/$EXT_ID" ] || [ -L "$CEP_DIR/$EXT_ID" ]; then
    echo "Removing existing installation..."
    rm -rf "$CEP_DIR/$EXT_ID"
fi

# Create symlink
echo "Creating symlink..."
ln -s "$SCRIPT_DIR" "$CEP_DIR/$EXT_ID"
echo "  $CEP_DIR/$EXT_ID -> $SCRIPT_DIR"

# Enable unsigned CEP extensions (debug mode) for all CSXS versions
echo ""
echo "Enabling debug mode for unsigned extensions..."
for v in 8 9 10 11 12 13 14 15; do
    defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null && \
        echo "  CSXS.$v: enabled" || true
done

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "  1. Restart Premiere Pro (or close and reopen)"
echo "  2. Go to Window > Extensions > Resonance"
echo "  3. Set your backend URL in the panel settings (gear icon)"
echo "     - Railway: your-app.up.railway.app"
echo "     - Local:   https://localhost:5001"
echo ""
