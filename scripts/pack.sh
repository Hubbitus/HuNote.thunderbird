#!/usr/bin/env bash
set -euo pipefail
rm -rf dist
mkdir -p dist
cd src && zip -r ../dist/hunote.xpi . -x '*.DS_Store' && cd -
echo "Created dist/hunote.xpi"
