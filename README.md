# Arcade

A small self-hosted arcade with leaderboards, built to be embedded in [WorkAdventure](https://workadventu.re).

It serves open-source browser games and freely licensed homebrew for retro consoles, and injects a tiny script into each page that

- keeps the volume low by default and adds a volume/mute control (HTML audio and Web Audio),
- detects the end of a game and submits the score to a shared leaderboard,
- takes the player name from WorkAdventure when the game is opened from a map (via the iframe API), or asks for it otherwise.

No game code is forked: the server patches the few lines it needs on the fly.

## Games

### Browser games (with leaderboard)

| Game | Score | Source | License |
|---|---|---|---|
| Space Huggers | Kills | [KilledByAPixel/SpaceHuggers](https://github.com/KilledByAPixel/SpaceHuggers) | GPL-3.0 |
| Radius Raid | Points | [jackrugile/radius-raid-js13k](https://github.com/jackrugile/radius-raid-js13k) | MIT |
| HexGL | Best time | [BKcore/HexGL](https://github.com/BKcore/HexGL) | MIT |

### Retro cabinets (EmulatorJS)

| Game | System | Source | License |
|---|---|---|---|
| Double Action Blaster Guys | NES | [NovaSquirrel/DABG](https://github.com/NovaSquirrel/DABG) | zlib |
| RHDE: Furniture Fight | NES | [pinobatch/rhde-nes](https://github.com/pinobatch/rhde-nes) | GNU All-Permissive |
| Thwaite | NES | [pinobatch/thwaite-nes](https://github.com/pinobatch/thwaite-nes) | GPL-3.0 |
| Nova the Squirrel | NES | [NovaSquirrel/NovaTheSquirrel](https://github.com/NovaSquirrel/NovaTheSquirrel) | GPL-3.0 / CC BY-NC-SA 4.0 |
| Concentration Room | NES | [pinobatch/croom-nes](https://github.com/pinobatch/croom-nes) | GPL-3.0 |
| Libbet and the Magic Floor | Game Boy | [pinobatch/libbet](https://github.com/pinobatch/libbet) | zlib |

The ROMs are the official release builds of these homebrew projects; their checksums are verified at build time.
The emulator is [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2.3 (GPL-3.0) with the `fceumm` and `gambatte` cores, served from the container itself (no CDN).

All games are fetched at build time. Ads and analytics are stripped when served. `/about` lists every game with its author, license and source.

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
| `GAMES_DIR` | `./games` | Browser games |
| `ROMS_DIR` | `./roms` | Retro ROMs |
| `EJS_DIR` | `./emulatorjs` | EmulatorJS `data` folder including cores |

The data directory must be writable by UID 1000.

## Embedding in WorkAdventure

Create an area with an **Open website** property pointing to e.g. `https://arcade.example.com/spacehuggers/` and enable **Allow API**, so the game can read the player's name.

## API

- `GET /_arcade/api/scores` – top 10 of every game
- `GET /_arcade/api/scores?game=hexgl&limit=25` – top list of one game
- `POST /_arcade/api/scores` – `{ "game": "radiusraid", "name": "Justin", "score": 1234 }`

Scores are kept per player; the leaderboard shows each player's best score (highest, or lowest for time-based games).

## Local development

Build the image once and copy the assets out of it:

```sh
docker build -t arcade .
id=$(docker create arcade)
for d in games roms emulatorjs; do docker cp "$id:/app/$d" .; done
docker rm "$id"
DATA_DIR=./data node server.mjs
```

Requires Node.js 22.5 or newer (uses the built-in `node:sqlite`).
