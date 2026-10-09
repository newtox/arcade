# Arcade

A small self-hosted arcade with leaderboards, built to be embedded in [WorkAdventure](https://workadventu.re).

It serves a few open-source browser games and injects a tiny script into each of them that

- keeps the volume low by default and adds a volume/mute control,
- detects the end of a game and submits the score to a shared leaderboard,
- takes the player name from WorkAdventure when the game is opened from a map (via the iframe API), or asks for it otherwise.

No game code is forked: the server patches the few lines it needs on the fly.

## Games

| Game | Source | License |
|---|---|---|
| 2048 | [gabrielecirulli/2048](https://github.com/gabrielecirulli/2048) | MIT |
| Pac-Man | [daleharvey/pacman](https://github.com/daleharvey/pacman) | WTFPL |
| Tetris | [jakesgordon/javascript-tetris](https://github.com/jakesgordon/javascript-tetris) | MIT |
| Hextris | [Hextris/hextris](https://github.com/Hextris/hextris) | GPL-3.0 |

The games are cloned at build time. Hextris' ads, analytics and score tracking are stripped when served.

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

The data directory must be writable by UID 1000.

## Embedding in WorkAdventure

Create an area with an **Open website** property pointing to e.g. `https://arcade.example.com/tetris/` and enable **Allow API**, so the game can read the player's name.

## API

- `GET /_arcade/api/scores` – top 10 of every game
- `GET /_arcade/api/scores?game=tetris&limit=25` – top list of one game
- `POST /_arcade/api/scores` – `{ "game": "tetris", "name": "Justin", "score": 1234 }`

Scores are kept per player; the leaderboard shows each player's best score.

## Local development

```sh
mkdir games && cd games
git clone --depth 1 https://github.com/gabrielecirulli/2048.git 2048
git clone --depth 1 https://github.com/Hextris/hextris.git hextris
git clone --depth 1 https://github.com/daleharvey/pacman.git pacman
git clone --depth 1 https://github.com/jakesgordon/javascript-tetris.git tetris
cd .. && DATA_DIR=./data node server.mjs
```

Requires Node.js 22.5 or newer (uses the built-in `node:sqlite`).
