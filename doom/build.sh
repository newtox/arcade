#!/bin/sh
# Builds doom.wasm: doomgeneric + Chocolate Doom's OPL music, patched for the browser.
# Usage: doom/build.sh <doomgeneric checkout> <doom-wasm checkout> <output.wasm>
# Needs zig (0.13) and patch. Set EXTRA_CFLAGS=-DDG_TEST for a test build.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DG=$(cd "$1" && pwd)
DW=$(cd "$2" && pwd)
OUT=$3
case "$OUT" in /*) ;; *) OUT="$(pwd)/$OUT" ;; esac
ZIG=${ZIG:-zig}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cp "$DG"/doomgeneric/*.c "$DG"/doomgeneric/*.h "$WORK"/
for f in doomgeneric_allegro.c doomgeneric_emscripten.c doomgeneric_linuxvt.c doomgeneric_sdl.c \
         doomgeneric_soso.c doomgeneric_sosox.c doomgeneric_win.c doomgeneric_xlib.c \
         i_allegromusic.c i_allegrosound.c i_sdlmusic.c i_sdlsound.c i_cdmus.c gusconf.c; do
    rm -f "$WORK/$f"
done
cp "$DW"/src/i_oplmusic.c "$DW"/src/midifile.c "$DW"/src/midifile.h "$WORK"/
for f in opl.c opl.h opl3.c opl3.h opl_internal.h opl_queue.c opl_queue.h; do
    cp "$DW/opl/$f" "$WORK"/
done
(cd "$WORK" && patch -p1 --quiet < "$HERE/web.patch")
cp "$HERE"/src/* "$WORK"/

cd "$WORK"
# shellcheck disable=SC2046,SC2086
$ZIG cc -target wasm32-wasi -O2 -s -mexec-model=reactor \
    -DFEATURE_SOUND -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 ${EXTRA_CFLAGS:-} \
    -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -Wno-everything \
    -lwasi-emulated-signal -lwasi-emulated-process-clocks \
    -Wl,--export=malloc -Wl,--export=free -Wl,--export-memory \
    -o "$OUT" $(ls ./*.c)
echo "built $OUT"
