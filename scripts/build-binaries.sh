#!/usr/bin/env bash
#
# Build LGTM standalone binaries for all supported platforms.
#
# Uses `bun scripts/build.ts` which calls Bun.build() with a plugin
# to stub react-devtools-core at bundle time.
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

VERSION="${LGTM_VERSION:-$(node -p "require('./package.json').version")}"

echo "🔨 Building LGTM v${VERSION} binaries"
echo ""

# Ensure output directory
mkdir -p dist

# Define targets
TARGETS=()
case "${1:-all}" in
  linux)
    TARGETS=("linux-x64" "linux-arm64")
    ;;
  darwin|macos)
    TARGETS=("darwin-x64" "darwin-arm64")
    ;;
  current)
    TARGETS=("current")
    ;;
  all|*)
    TARGETS=("linux-x64" "linux-arm64" "darwin-x64" "darwin-arm64")
    ;;
esac

# Build each target
for target in "${TARGETS[@]}"; do
  if [ "$target" = "current" ]; then
    echo "  → Building for current platform → dist/lgtm"
    bun scripts/build.ts
  else
    echo "  → Building for $target → dist/lgtm-${target}"
    bun scripts/build.ts --target "$target"
  fi
done

echo ""
echo "✓ Build complete. Binaries in dist/:"
ls -lh dist/lgtm* 2>/dev/null || true
echo ""

# Generate checksums if sha256sum is available
if command -v sha256sum &>/dev/null; then
  echo "📝 Generating checksums..."
  cd dist
  sha256sum lgtm-* > checksums-sha256.txt 2>/dev/null || true
  cd ..
  echo "  → dist/checksums-sha256.txt"
elif command -v shasum &>/dev/null; then
  echo "📝 Generating checksums..."
  cd dist
  shasum -a 256 lgtm-* > checksums-sha256.txt 2>/dev/null || true
  cd ..
  echo "  → dist/checksums-sha256.txt"
fi

echo ""
echo "Done! To test locally: ./dist/lgtm --help"
