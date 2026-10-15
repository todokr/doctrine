#!/usr/bin/env bash
# app:release で作った .app と .dmg を確かめる。app ディレクトリで流す。
# 最後の行に .dmg のパス（app からの相対）を出す。release.yml が添付に使う。
#
# hardened runtime の有無と実際の起動まで見るのは、署名の検証（codesign --verify）が
# hardened runtime で JIT の entitlement が無い SEA の node を通してしまうため。
set -euo pipefail

bundle=src-tauri/target/aarch64-apple-darwin/release/bundle
app="$bundle/macos/doctrine.app"
dctld="$app/Contents/MacOS/dctld"

fail() {
  echo "検証失敗: $1" >&2
  exit 1
}

[ -d "$app" ] || fail "$app が無い"
[ -f "$dctld" ] && [ -x "$dctld" ] || fail "$dctld が実行可能なファイルとして無い"

archs=$(lipo -archs "$dctld")
[ "$archs" = "arm64" ] || fail "同梱した dctld のアーキテクチャが arm64 ではない（$archs）"

codesign --verify --deep --strict --verbose=2 "$app" || fail ".app の署名検証（--deep --strict）が通らない"
codesign --verify --strict --verbose=2 "$dctld" || fail "同梱した dctld の署名検証が通らない"

# codesign -d は詳細を stderr に出す
if codesign -d --verbose=2 "$dctld" 2>&1 | grep -E '^CodeDirectory .*flags=' | grep -q runtime; then
  fail "同梱した dctld に hardened runtime（runtime フラグ）が付いている"
fi

tmp=$(mktemp -d)
pid=""
cleanup() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

sock="$tmp/dctld.sock"
DOCTRINE_SOCKET="$sock" DOCTRINE_STATE_DIR="$tmp/state" DOCTRINE_CONFIG_DIR="$tmp/config" \
  "$dctld" >"$tmp/dctld.log" 2>&1 &
pid=$!

# 0.1 秒間隔で最大 10 秒、ソケットができるのを待つ
for _ in $(seq 1 100); do
  [ -S "$sock" ] && break
  kill -0 "$pid" 2>/dev/null || fail "同梱した dctld が起動中に終了した: $(cat "$tmp/dctld.log")"
  sleep 0.1
done
[ -S "$sock" ] || fail "同梱した dctld が 10 秒以内にソケットを作らなかった: $(cat "$tmp/dctld.log")"

shopt -s nullglob
dmgs=("$bundle"/dmg/doctrine_*_aarch64.dmg)
[ "${#dmgs[@]}" -eq 1 ] || fail "$bundle/dmg に doctrine_*_aarch64.dmg がちょうど 1 つ無い（${#dmgs[@]} 個）"

echo "${dmgs[0]}"
