# Arcade

A small self-hosted arcade with leaderboards, built to be embedded in [WorkAdventure](https://workadventu.re).

- **Pac-Man** fills the whole window and has a leaderboard.
- **Doom** and **Freedoom** run directly in the browser, with music, sound, savegames and a shared leaderboard.
- **Console cabinets** (N64, NES, SNES, Game Boy, GBA, Mega Drive, PlayStation) run games the players load from their own disk. ROMs never leave the player's browser: they are kept in IndexedDB on request and are not uploaded or hosted by the server.
- Every page gets a small overlay with volume control, and the player name comes from WorkAdventure when opened from a map (via the iframe API).

## Pac-Man

[daleharvey/pacman](https://github.com/daleharvey/pacman) (WTFPL), vendored in `public/pacman/` with small changes listed at the top of `pacman.js`: it is drawn at 4× resolution and scaled to the window, Enter/Space start a game, WASD moves, M mutes, and the score is submitted when the last life is lost.

## Doom

The engine is [doomgeneric](https://github.com/ozkl/doomgeneric) compiled to WebAssembly (WASI reactor) with `zig cc`, plus Chocolate Doom's OPL music emulation from [cloudflare/doom-wasm](https://github.com/cloudflare/doom-wasm). `doom/build.sh` takes both checkouts at pinned commits, applies `doom/web.patch` and adds the browser layer in `doom/src/`:

- `doomgeneric_web.c` – video, input, sound effects and the hooks for the page
- `opl_web.c` – single-threaded OPL backend that the page pulls audio from
- the patch makes the screen wipe non-blocking, removes busy-waiting and reports finished levels, new games, loaded savegames and cheats

`public/doom/player.js` runs the module with [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim), draws to a canvas, plays sound through Web Audio and stores config and savegames in IndexedDB.

| IWAD | License |
|---|---|
| `doom1.wad` (Doom shareware v1.9) | Freely distributable, unmodified and free of charge |
| `freedoom1.wad` ([Freedoom](https://freedoom.github.io/) 0.13.0) | BSD-3-Clause |

Both are downloaded at build time and verified by checksum.

### Scoring

Each finished level adds `kills × 100 + items × 20 + secrets × 500 + 20 per second under par`, multiplied by the skill level (×0.5 … ×2). A run starts with *New Game*; runs with cheats or loaded savegames are not submitted. The best total per player counts.

## Consoles

The console pages use [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2.3 with the cores `fceumm`, `snes9x`, `mupen64plus_next`, `gambatte`, `mgba`, `genesis_plus_gx` and `pcsx_rearmed`, all served from the container (no CDN). Save data is kept by EmulatorJS in the browser.

## Running

```sh
docker compose up -d
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `/data` | Where `scores.sqlite` is stored |
| `WA_URL` | – | WorkAdventure base URL, used to load `iframe_api.js` for the player name |
| `FRAME_ANCESTORS` | `'self'` | Sites allowed to embed the arcade |
| `ARCADE_TITLE` | `Arcade` | Title on the start page |
| `PUBLIC_DIR`, `WADS_DIR`, `EJS_DIR` | inside the image | Static files, IWADs, EmulatorJS |

The data directory must be writable by UID 1000.

## Embedding in WorkAdventure

Create an area with **Open website** pointing to e.g. `https://arcade.example.com/doom/`, enable **Allow API** (for the player name) and set the iframe policy to `fullscreen; gamepad; autoplay`.

## API

- `GET /_arcade/api/scores` – top 10 of every game with a leaderboard
- `GET /_arcade/api/scores?game=doom&limit=25` – top list of one game
- `POST /_arcade/api/scores` – `{ "game": "doom", "name": "Justin", "score": 1234 }`

## Licenses

The arcade code is by its authors; Pac-Man in `public/pacman/` is WTFPL; the Doom port in `doom/` is GPL-2.0 like doomgeneric and Chocolate Doom. See `/about` in the running arcade for all components.
