#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Building Cactus XCFramework..."

# Clone cactus if not already present
if [ ! -d "cactus-src" ]; then
    git clone https://github.com/cactus-compute/cactus cactus-src
fi

cd cactus-src
source ./setup
cactus build --apple
cd "$SCRIPT_DIR"

# Copy framework into project
mkdir -p Frameworks
cp -R cactus-src/apple/cactus-ios.xcframework Frameworks/

echo "==> Generating Xcode project..."
xcodegen generate

echo ""
echo "Done! Open VoiceBridge.xcodeproj in Xcode:"
echo "  open $SCRIPT_DIR/VoiceBridge.xcodeproj"
