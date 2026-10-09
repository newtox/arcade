// Pac-Man and the Doom games come with the arcade and have a leaderboard; Doom uses freely distributable IWADs.
// Console cabinets run ROMs the players load from their own disk; the server never hosts ROMs.
// Texts the players see are { de, en } objects.

export const GAMES = [
    {
        id: "pacman",
        title: "Pac-Man",
        kind: "pacman",
        description: { de: "Der Klassiker im Vollbild. Pfeiltasten oder WASD, P pausiert, M schaltet den Ton aus.", en: "The classic, full screen. Arrow keys or WASD, P pauses, M mutes." },
        score: { label: { de: "Punkte", en: "Points" }, order: "desc", format: "number" },
        author: "Dale Harvey",
        license: "WTFPL",
        source: "https://github.com/daleharvey/pacman",
    },
    {
        id: "doom",
        title: "Doom",
        kind: "doom",
        iwad: "doom1.wad",
        description: { de: "Das Original von 1993 – Shareware-Episode „Knee-Deep in the Dead“ (9 Level).", en: "The 1993 original – shareware episode “Knee-Deep in the Dead” (9 levels)." },
        score: { label: { de: "Punkte", en: "Points" }, order: "desc", format: "number" },
        author: "id Software",
        license: { de: "Shareware, frei weitergebbar", en: "Shareware, freely distributable" },
        source: "https://doomwiki.org/wiki/DOOM1.WAD",
    },
    {
        id: "freedoom",
        title: "Freedoom",
        kind: "doom",
        iwad: "freedoom1.wad",
        description: { de: "Komplett freies Doom mit 4 Episoden und 36 Leveln.", en: "Completely free Doom with 4 episodes and 36 levels." },
        score: { label: { de: "Punkte", en: "Points" }, order: "desc", format: "number" },
        author: "Freedoom-Projekt",
        license: "BSD-3-Clause",
        source: "https://freedoom.github.io/",
    },
    {
        id: "n64",
        title: "Nintendo 64",
        kind: "console",
        core: "mupen64plus_next",
        extensions: [".z64", ".n64", ".v64", ".zip", ".7z"],
        hint: { de: "Braucht einen flotten Rechner; ein Gamepad wird empfohlen.", en: "Needs a fast computer; a gamepad is recommended." },
    },
    {
        id: "nes",
        title: "NES",
        kind: "console",
        core: "fceumm",
        extensions: [".nes", ".fds", ".unf", ".unif", ".zip", ".7z"],
    },
    {
        id: "snes",
        title: "Super Nintendo",
        kind: "console",
        core: "snes9x",
        extensions: [".sfc", ".smc", ".fig", ".swc", ".bs", ".zip", ".7z"],
    },
    {
        id: "gameboy",
        title: "Game Boy / Color",
        kind: "console",
        core: "gambatte",
        extensions: [".gb", ".gbc", ".dmg", ".zip", ".7z"],
    },
    {
        id: "gba",
        title: "Game Boy Advance",
        kind: "console",
        core: "mgba",
        extensions: [".gba", ".zip", ".7z"],
    },
    {
        id: "megadrive",
        title: "Mega Drive",
        kind: "console",
        core: "genesis_plus_gx",
        extensions: [".md", ".gen", ".smd", ".bin", ".sms", ".gg", ".zip", ".7z"],
        hint: { de: "Läuft auch mit Master-System- und Game-Gear-Spielen.", en: "Also runs Master System and Game Gear games." },
    },
    {
        id: "playstation",
        title: "PlayStation",
        kind: "console",
        core: "pcsx_rearmed",
        extensions: [".chd", ".pbp", ".iso", ".bin", ".cue", ".zip", ".7z"],
        hint: { de: "Am besten eine einzelne .chd- oder .pbp-Datei verwenden.", en: "Best use a single .chd or .pbp file." },
    },
];

export const CREDITS = [
    { title: "Doom-Engine (doomgeneric)", author: "id Software, Chocolate Doom, ozkl", license: "GPL-2.0", source: "https://github.com/ozkl/doomgeneric" },
    { title: "OPL-Musik (Chocolate Doom / Nuked OPL3)", author: "Simon Howard, Nuke.YKT", license: "GPL-2.0 / LGPL-2.1", source: "https://github.com/chocolate-doom/chocolate-doom" },
    { title: "browser_wasi_shim", author: "bjorn3", license: "MIT / Apache-2.0", source: "https://github.com/bjorn3/browser_wasi_shim" },
    { title: "EmulatorJS (inkl. Libretro-Cores)", author: "EmulatorJS & Libretro contributors", license: { de: "GPL-3.0 (Cores: jeweilige Lizenzen)", en: "GPL-3.0 (cores: their own licenses)" }, source: "https://github.com/EmulatorJS/EmulatorJS" },
];
