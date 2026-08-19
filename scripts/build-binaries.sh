#!/usr/bin/env bash
#
# Build LGTM standalone binaries for all supported platforms.
#
# Uses `bun build --compile` to produce self-contained executables
# that include the Bun runtime — no installation required.
#
# Targets:
#   - linux-x64    (Ubuntu, Debian, Fedora, etc.)
#   - linux-arm64  (Raspberry Pi, AWS Graviton, etc.)
#   - darwin-x64   (Intel Macs)
#   - darwin-arm64  (Apple Silicon Macs)
#
# Output: dist/lgtm-<platform>-<arch>
#
# Usage:
#   ./scripts/build-binaries.sh          # Build all platforms
#   ./scripts/build-binaries.sh linux    # Build Linux only
#   ./scripts/build-binaries.sh darwin   # Build macOS only
#   ./scripts/build-binaries.sh current  # Build current platform only

set -euo pipefail

ENTRY="packages/core/src/index.ts"
OUTDIR="dist"
VERSION="${LGTM_VERSION:-$(node -p "require('./package.json').version")}"

echo "🔨 Building LGTM v${VERSION} binaries"
echo ""

# Ensure output directory
mkdir -p "$OUTDIR"

# Define targets
TARGETS=()
case "${1:-all}" in
  linux)
    TARGETS=("bun-linux-x64" "bun-linux-arm64")
    ;;
  darwin|macos)
    TARGETS=("bun-darwin-x64" "bun-darwin-arm64")
    ;;
  current)
    TARGETS=("current")
    ;;
  all|*)
    TARGETS=("bun-linux-x64" "bun-linux-arm64" "bun-darwin-x64" "bun-darwin-arm64")
    ;;
esac

# Build each target
for target in "${TARGETS[@]}"; do
  if [ "$target" = "current" ]; then
    outfile="$OUTDIR/lgtm"
    echo "  → Building for current platform → $outfile"
    bun build "$ENTRY" --compile --outfile "$outfile"
  else
    # Extract os-arch from bun-<os>-<arch>
    platform="${target#bun-}"
    outfile="$OUTDIR/lgtm-${platform}"
    echo "  → Building for $platform → $outfile"
    bun build "$ENTRY" --compile --target="$target" --outfile "$outfile"
  fi
done

echo ""
echo "✓ Build complete. Binaries in $OUTDIR/:"
ls -lh "$OUTDIR"/lgtm* 2>/dev/null || true
echo ""

# Generate checksums if sha256sum is available
if command -v sha256sum &>/dev/null; then
  echo "📝 Generating checksums..."
  cd "$OUTDIR"
  sha256sum lgtm-* > checksums-sha256.txt 2>/dev/null || true
  cd ..
  echo "  → $OUTDIR/checksums-sha256.txt"
elif command -v shasum &>/dev/null; then
  echo "📝 Generating checksums..."
  cd "$OUTDIR"
  shasum -a 256 lgtm-* > checksums-sha256.txt 2>/dev/null || true
  cd ..
  echo "  → $OUTDIR/checksums-sha256.txt"
fi

echo ""
echo "Done! To test locally: ./$OUTDIR/lgtm --help"
