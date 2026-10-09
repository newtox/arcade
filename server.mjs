import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { GAMES, CREDITS } from "./games.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const APP_DIR = path.dirname(new URL(import.meta.url).pathname);
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? path.join(APP_DIR, "public");
const WADS_DIR = process.env.WADS_DIR ?? path.join(APP_DIR, "wads");
const EJS_DIR = process.env.EJS_DIR ?? path.join(APP_DIR, "emulatorjs");
const DATA_DIR = process.env.DATA_DIR ?? path.join(APP_DIR, "data");
const WA_URL = (process.env.WA_URL ?? "").replace(/\/+$/, "");
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS ?? "'self'";
const TITLE = process.env.ARCADE_TITLE ?? "Arcade";

// Content hash per public asset, appended as ?v=… so browsers and CDNs pick up new versions immediately.
const assetVersion = new Map();
function asset(name) {
    if (!assetVersion.has(name)) {
        let version = "0";
        try {
            version = createHash("sha256").update(readFileSync(path.join(PUBLIC_DIR, name))).digest("hex").slice(0, 10);
        } catch {}
        assetVersion.set(name, version);
    }
    return `/_arcade/${name}?v=${assetVersion.get(name)}`;
}

const gameById = new Map(GAMES.map((g) => [g.id, g]));
const scoredGames = GAMES.filter((g) => g.score);

await fs.mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "scores.sqlite"));
db.exec(`
    CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game TEXT NOT NULL,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS scores_game_score ON scores (game, score);
`);

const statements = {
    desc: {
        top: db.prepare(`SELECT name, MAX(score) AS score, MIN(created_at) AS created_at FROM scores WHERE game = ?
                         GROUP BY name ORDER BY score DESC, created_at ASC LIMIT ?`),
        rank: db.prepare(`SELECT COUNT(*) AS better FROM (SELECT MAX(score) AS best FROM scores WHERE game = ? GROUP BY name) WHERE best > ?`),
    },
    asc: {
        top: db.prepare(`SELECT name, MIN(score) AS score, MIN(created_at) AS created_at FROM scores WHERE game = ?
                         GROUP BY name ORDER BY score ASC, created_at ASC LIMIT ?`),
        rank: db.prepare(`SELECT COUNT(*) AS better FROM (SELECT MIN(score) AS best FROM scores WHERE game = ? GROUP BY name) WHERE best < ?`),
    },
};
const insertStatement = db.prepare("INSERT INTO scores (game, name, score) VALUES (?, ?, ?)");

export function top(game, limit = 10) {
    return statements[game.score.order].top
        .all(game.id, limit)
        .map((r) => ({ name: r.name, score: r.score, date: r.created_at }));
}

export function cleanName(raw) {
    if (typeof raw !== "string") return null;
    const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
    return name.length > 0 ? name : null;
}

export function formatScore(game, value, lang = "de") {
    if (game.score.format === "time") {
        const ms = Math.max(0, Math.round(value));
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${m}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
    }
    return Number(value).toLocaleString(lang === "de" ? "de-DE" : "en-GB");
}

const lastSubmit = new Map();

function clientIp(req) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf;
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
    return req.socket.remoteAddress ?? "";
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `frame-ancestors ${FRAME_ANCESTORS}`,
        "Referrer-Policy": "same-origin",
        ...headers,
    });
    res.end(body);
}

function json(res, status, data) {
    send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}

function html(res, body, headers = {}) {
    send(res, 200, body, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Language, Cookie", ...headers });
}

async function readBody(req, limit = 4096) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error("too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

const publicGame = (g) => ({ id: g.id, title: g.title, score: g.score });

async function handleApi(req, res, url) {
    if (url.pathname !== "/_arcade/api/scores") return json(res, 404, { error: "not found" });

    if (req.method === "GET") {
        const id = url.searchParams.get("game");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 100);
        if (id) {
            const game = gameById.get(id);
            if (!game?.score) return json(res, 404, { error: "unknown game" });
            return json(res, 200, { ...publicGame(game), scores: top(game, limit) });
        }
        return json(res, 200, { games: scoredGames.map((g) => ({ ...publicGame(g), scores: top(g, limit) })) });
    }

    if (req.method === "POST") {
        let data;
        try {
            data = JSON.parse(await readBody(req));
        } catch {
            return json(res, 400, { error: "invalid body" });
        }
        const game = gameById.get(data?.game);
        const name = cleanName(data?.name);
        const score = Number(data?.score);
        if (!game?.score) return json(res, 400, { error: "unknown game" });
        if (!name) return json(res, 400, { error: "invalid name" });
        if (!Number.isInteger(score) || score <= 0 || score > 100_000_000) return json(res, 400, { error: "invalid score" });

        const key = `${clientIp(req)}|${game.id}`;
        const now = Date.now();
        if (now - (lastSubmit.get(key) ?? 0) < 3000) return json(res, 429, { error: "too many requests" });
        lastSubmit.set(key, now);
        if (lastSubmit.size > 10_000) lastSubmit.clear();

        insertStatement.run(game.id, name, score);
        const { better } = statements[game.score.order].rank.get(game.id, score);
        return json(res, 201, { ...publicGame(game), name, score, rank: better + 1, scores: top(game, 10) });
    }

    return json(res, 405, { error: "method not allowed" });
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
    ".data": "application/octet-stream",
    ".wad": "application/octet-stream",
};

// ---------- Language ----------
// ?lang=de|en (remembered in a cookie) wins, then the cookie, then the browser's Accept-Language.
// Everything that is not German gets English.

const LANG_COOKIE = "arcade_lang";

function matchLang(value) {
    if (!value) return undefined;
    const ranked = String(value)
        .split(",")
        .map((part) => {
            const [tag, ...params] = part.trim().toLowerCase().split(";");
            const q = params.map((p) => /^q=([\d.]+)$/.exec(p.trim())).find(Boolean);
            return { tag, q: q ? Number(q[1]) : 1 };
        })
        .filter((e) => e.tag && e.q > 0)
        .sort((a, b) => b.q - a.q);
    for (const { tag } of ranked) {
        if (tag === "de" || tag.startsWith("de-")) return "de";
        if (tag === "en" || tag.startsWith("en-")) return "en";
    }
    return undefined;
}

function cookieLang(req) {
    const m = /(?:^|;\s*)arcade_lang=(de|en)(?:;|$)/.exec(req.headers.cookie ?? "");
    return m ? m[1] : undefined;
}

export function langFor(req, url) {
    const asked = url.searchParams.get("lang");
    if (asked === "de" || asked === "en") return { lang: asked, remember: asked !== cookieLang(req) };
    return { lang: cookieLang(req) ?? matchLang(req.headers["accept-language"]) ?? "en", remember: false };
}

/** Picks the text of a { de, en } value; plain strings are the same in both languages. */
export const L = (value, lang) => (value && typeof value === "object" ? value[lang] ?? value.de : value);

const TEXT = {
    de: {
        tagline: "Insert coin – oder einfach klicken.",
        noEntries: "Noch keine Einträge",
        consoles: "🎮 Konsolen",
        consolesSub: "Lade deine eigenen Spiele – die Datei bleibt in deinem Browser, hochgeladen wird nichts.",
        defaultHint: "Eigene ROM laden und losspielen.",
        fullBoard: "Komplette Bestenliste",
        gamesLicenses: "Spiele &amp; Lizenzen",
        board: "Bestenliste",
        boardTitle: "🏆 BESTENLISTE",
        back: "← Zurück zur Arcade",
        name: "Name",
        date: "Datum",
        doomScoring: "Doom: Punkte pro Level: Kills × 100, Items × 20, Secrets × 500, plus 20 pro Sekunde unter Par – mal Schwierigkeit (Baby ×0,5 bis Albtraum ×2). Gezählt wird der Durchgang ab „Neues Spiel“; Cheats oder geladene Spielstände zählen nicht.",
        licensesTitle: "SPIELE &amp; LIZENZEN",
        what: "Was", by: "Von", license: "Lizenz", source: "Quelle",
        aboutNote: "Doom (Shareware) und Freedoom werden unverändert und kostenlos bereitgestellt, wie es ihre Lizenzen erlauben. Für die Konsolen stellt die Arcade keine Spiele bereit: ROMs werden ausschließlich im Browser der Spieler geladen und dort gespeichert, der Server sieht sie nie. Der Quellcode der Arcade liegt unter",
        clickToStart: "▶ Klicken zum Starten",
        loading: "lädt …",
        doomKeys: [["WASD / Pfeile", "Laufen (A/D seitwärts)"], ["Maus", "Umsehen – ins Bild klicken fängt die Maus, Esc gibt sie frei"], ["Strg / Linksklick", "Schießen"], ["Leertaste / E", "Türen &amp; Schalter"], ["Shift", "Rennen"], ["1–7", "Waffe wechseln"], ["Esc", "Menü (Neues Spiel, Speichern, Lautstärke)"]],
        doomNote: "Für die Bestenliste zählt jeder geschaffte Level ab „Neues Spiel“. Spielstände und Einstellungen werden in deinem Browser gespeichert.",
        pacKeys: [["Pfeile / WASD", "Laufen"], ["P", "Pause"], ["N", "Neues Spiel"], ["M", "Spielton aus/an"], ["F", "Echtes Vollbild"]],
        pacNote: "Wenn das letzte Leben weg ist, landen deine Punkte in der Bestenliste.",
        romIntro: "Lade ein Spiel von deinem Computer. Die Datei bleibt in deinem Browser – hochgeladen wird nichts.",
        romPick: "📂 ROM auswählen oder hierher ziehen",
        romRemember: "In diesem Browser merken",
        yourGames: "Deine Spiele",
        listLoading: "Lädt …",
        other: { lang: "en", label: "English" },
    },
    en: {
        tagline: "Insert coin – or just click.",
        noEntries: "No entries yet",
        consoles: "🎮 Consoles",
        consolesSub: "Load your own games – the file stays in your browser, nothing is uploaded.",
        defaultHint: "Load your own ROM and play.",
        fullBoard: "Full leaderboard",
        gamesLicenses: "Games &amp; licenses",
        board: "Leaderboard",
        boardTitle: "🏆 LEADERBOARD",
        back: "← Back to the arcade",
        name: "Name",
        date: "Date",
        doomScoring: "Doom: points per level: kills × 100, items × 20, secrets × 500, plus 20 per second under par – times the skill level (Baby ×0.5 to Nightmare ×2). A run counts from “New Game”; cheats or loaded savegames do not count.",
        licensesTitle: "GAMES &amp; LICENSES",
        what: "What", by: "By", license: "License", source: "Source",
        aboutNote: "Doom (shareware) and Freedoom are provided unchanged and free of charge, as their licenses allow. The arcade provides no games for the consoles: ROMs are only loaded and stored in the players' browsers, the server never sees them. The arcade's source code is at",
        clickToStart: "▶ Click to start",
        loading: "loading …",
        doomKeys: [["WASD / arrows", "Move (A/D strafe)"], ["Mouse", "Look around – click the picture to capture the mouse, Esc releases it"], ["Ctrl / left click", "Fire"], ["Space / E", "Doors &amp; switches"], ["Shift", "Run"], ["1–7", "Switch weapon"], ["Esc", "Menu (new game, save, volume)"]],
        doomNote: "Every level finished from “New Game” counts for the leaderboard. Savegames and settings are stored in your browser.",
        pacKeys: [["Arrows / WASD", "Move"], ["P", "Pause"], ["N", "New game"], ["M", "Game sound off/on"], ["F", "Real full screen"]],
        pacNote: "When your last life is gone, your points go to the leaderboard.",
        romIntro: "Load a game from your computer. The file stays in your browser – nothing is uploaded.",
        romPick: "📂 Choose a ROM or drop it here",
        romRemember: "Remember in this browser",
        yourGames: "Your games",
        listLoading: "Loading …",
        other: { lang: "de", label: "Deutsch" },
    },
};

function scriptTag(game, lang) {
    const attrs = [`src="${asset("arcade.js")}"`, `data-game="${game.id}"`];
    if (game.score) {
        attrs.push(`data-order="${game.score.order}"`, `data-format="${game.score.format}"`, `data-label="${esc(L(game.score.label, lang))}"`);
    }
    if (WA_URL) attrs.push(`data-wa="${WA_URL}"`);
    return `<script ${attrs.join(" ")}></script>`;
}

async function serveFile(res, filePath, { immutable = false } = {}) {
    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch {
        return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
    }
    if (!stat.isFile()) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
    const type = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const data = await fs.readFile(filePath);
    return send(res, 200, data, {
        "Content-Type": type,
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function layout(title, body, lang) {
    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${asset("landing.css")}">
</head>
<body>
${body}
</body>
</html>`;
}

const langSwitch = (lang, path) => {
    const other = TEXT[lang].other;
    return `<a href="${path}?lang=${other.lang}" hreflang="${other.lang}" lang="${other.lang}">${other.label}</a>`;
};

function landingPage(lang) {
    const T = TEXT[lang];
    const scored = GAMES.filter((g) => g.kind === "doom" || g.kind === "pacman").map((g) => {
        const scores = top(g, 3);
        const rows = scores.length
            ? scores.map((s, i) => `<li><span>${["🥇", "🥈", "🥉"][i]} ${esc(s.name)}</span><b>${formatScore(g, s.score, lang)}</b></li>`).join("")
            : `<li class="empty">${T.noEntries}</li>`;
        return `<a class="game" href="/${g.id}/?lang=${lang}"><strong>${esc(g.title)}</strong><em>${esc(L(g.description, lang))}</em><ol>${rows}</ol></a>`;
    }).join("");
    const consoles = GAMES.filter((g) => g.kind === "console").map((g) =>
        `<a class="game console" href="/${g.id}/?lang=${lang}"><strong>${esc(g.title)}</strong><small>${esc(g.extensions.filter((e) => e !== ".zip" && e !== ".7z").join(" "))}</small><em>${esc(L(g.hint, lang) ?? T.defaultHint)}</em></a>`,
    ).join("");
    return layout(TITLE, `<h1>● ${esc(TITLE.toUpperCase())} ●</h1>
<p class="sub">${T.tagline}</p>
<main class="grid">${scored}</main>
<h2 class="section">${T.consoles}</h2>
<p class="sub">${T.consolesSub}</p>
<main class="grid">${consoles}</main>
<p class="foot"><a href="/scores?lang=${lang}">${T.fullBoard}</a> · <a href="/about?lang=${lang}">${T.gamesLicenses}</a> · ${langSwitch(lang, "/")}</p>`, lang);
}

function scoresPage(lang) {
    const T = TEXT[lang];
    const sections = scoredGames.map((g) => {
        const scores = top(g, 25);
        const rows = scores.length
            ? scores.map((s, i) => `<tr><td>${i + 1}.</td><td>${esc(s.name)}</td><td>${formatScore(g, s.score, lang)}</td><td>${esc(s.date.slice(0, 10))}</td></tr>`).join("")
            : `<tr><td colspan="4" class="empty">${T.noEntries}</td></tr>`;
        return `<section><h2><a href="/${g.id}/?lang=${lang}">${esc(g.title)}</a></h2><table><thead><tr><th>#</th><th>${T.name}</th><th>${esc(L(g.score.label, lang))}</th><th>${T.date}</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }).join("");
    return layout(`${T.board} – ${TITLE}`, `<h1>${T.boardTitle}</h1>
<p class="sub"><a href="/?lang=${lang}">${T.back}</a> · ${langSwitch(lang, "/scores")}</p>
<main class="tables">${sections}</main>
<p class="credits">${esc(T.doomScoring)}</p>`, lang);
}

function aboutPage(lang) {
    const T = TEXT[lang];
    const rows = [...GAMES.filter((g) => g.author), ...CREDITS].map((g) =>
        `<tr><td>${esc(g.title)}</td><td>${esc(g.author)}</td><td>${esc(L(g.license, lang))}</td><td><a href="${esc(g.source)}">${T.source}</a></td></tr>`,
    ).join("");
    return layout(`${T.gamesLicenses.replace("&amp;", "&")} – ${TITLE}`, `<h1>${T.licensesTitle}</h1>
<p class="sub"><a href="/?lang=${lang}">${T.back}</a> · ${langSwitch(lang, "/about")}</p>
<main class="tables"><section><table><thead><tr><th>${T.what}</th><th>${T.by}</th><th>${T.license}</th><th>${T.source}</th></tr></thead><tbody>${rows}</tbody></table>
<p class="note">${T.aboutNote} <a href="https://github.com/newtox/wa-arcade">github.com/newtox/wa-arcade</a>.</p></section></main>`, lang);
}

const keyList = (keys) => `<dl>\n${keys.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("\n")}\n</dl>`;

function doomPage(game, lang) {
    const T = TEXT[lang];
    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(game.title)} – ${esc(TITLE)}</title>
<link rel="stylesheet" href="${asset("landing.css")}">
<style>.doom-start:not(.ready) button::after { content:" (${T.loading})"; }</style>
${scriptTag(game, lang)}
</head>
<body class="doom">
<div id="doom" data-iwad="${esc(game.iwad)}" data-wad-url="/_arcade/wads/${esc(game.iwad)}" data-wasm-url="${asset("doom/doom.wasm")}">
<canvas width="320" height="200" tabindex="0"></canvas>
<div class="doom-start">
<h1>${esc(game.title.toUpperCase())}</h1>
<button type="button">${T.clickToStart}</button>
${keyList(T.doomKeys)}
<p>${T.doomNote}</p>
</div>
</div>
<script type="module" src="${asset("doom/player.js")}"></script>
</body>
</html>`;
}

function consolePage(game, lang) {
    const T = TEXT[lang];
    const accept = game.extensions.join(",");
    const hint = L(game.hint, lang);
    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(game.title)} – ${esc(TITLE)}</title>
<link rel="stylesheet" href="${asset("landing.css")}">
${scriptTag(game, lang)}
</head>
<body class="console-page">
<div id="console" data-system="${esc(game.id)}" data-core="${esc(game.core)}" data-extensions="${esc(accept)}" data-ejs="/_arcade/ejs/">
<div class="picker">
<h1>${esc(game.title.toUpperCase())}</h1>
<p>${T.romIntro}${hint ? `<br>${esc(hint)}` : ""}</p>
<label class="drop"><strong>${T.romPick}</strong><small>${esc(game.extensions.join(" "))}</small><input type="file" accept="${esc(accept)}"></label>
<label class="remember"><input type="checkbox" name="remember" checked> ${T.romRemember}</label>
<div class="status" role="status"></div>
<h2>${T.yourGames}</h2>
<ul class="library"><li class="empty">${T.listLoading}</li></ul>
<a class="back" href="/?lang=${lang}">${T.back}</a>
</div>
<div id="game"></div>
</div>
<script src="${asset("console/console.js")}"></script>
</body>
</html>`;
}

function pacmanPage(game, lang) {
    const T = TEXT[lang];
    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(game.title)} – ${esc(TITLE)}</title>
<link rel="stylesheet" href="${asset("landing.css")}">
<style>@font-face { font-family:"BDCartoonShoutRegular"; src:url("${asset("pacman/BD_Cartoon_Shout-webfont.ttf")}") format("truetype"); }
.pacman-start:not(.ready) button::after { content:" (${T.loading})"; }</style>
${scriptTag(game, lang)}
</head>
<body class="pacman">
<div id="pacman" data-root="/_arcade/pacman/">
<div class="board"></div>
<div class="pacman-start">
<h1>${esc(game.title.toUpperCase())}</h1>
<button type="button" disabled>${T.clickToStart}</button>
${keyList(T.pacKeys)}
<p>${T.pacNote}</p>
</div>
</div>
<script src="${asset("pacman/pacman.js")}"></script>
<script src="${asset("pacman/player.js")}"></script>
</body>
</html>`;
}

const wads = new Set(GAMES.filter((g) => g.iwad).map((g) => g.iwad));

export const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = decodeURIComponent(url.pathname);

        if (pathname === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });
        if (pathname === "/favicon.ico") return send(res, 204, "", { "Cache-Control": "public, max-age=86400" });
        if (pathname.startsWith("/_arcade/api/")) return handleApi(req, res, url);
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
        const { lang, remember } = langFor(req, url);
        const page = (body) =>
            html(res, body, remember ? { "Set-Cookie": `${LANG_COOKIE}=${lang}; Path=/; Max-Age=31536000; SameSite=None; Secure` } : {});
        if (pathname === "/" || pathname === "/index.html") return page(landingPage(lang));
        if (pathname === "/scores") return page(scoresPage(lang));
        if (pathname === "/about") return page(aboutPage(lang));

        const parts = pathname.split("/");
        if (parts.some((part) => part.startsWith(".") || part === "..")) return send(res, 404, "Not found");
        const immutable = url.searchParams.has("v");

        if (pathname.startsWith("/_arcade/ejs/")) {
            return serveFile(res, path.join(EJS_DIR, pathname.slice("/_arcade/ejs/".length)));
        }
        if (pathname.startsWith("/_arcade/wads/")) {
            const wad = pathname.slice("/_arcade/wads/".length);
            if (!wads.has(wad)) return send(res, 404, "Not found");
            return serveFile(res, path.join(WADS_DIR, wad), { immutable: true });
        }
        if (pathname.startsWith("/_arcade/")) {
            return serveFile(res, path.join(PUBLIC_DIR, pathname.slice("/_arcade/".length)), { immutable });
        }

        const [, id, ...rest] = parts;
        const game = gameById.get(id);
        if (!game) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
        if (rest.length === 0) return send(res, 301, "", { Location: `/${id}/${url.search}` });
        if (rest.join("/") !== "") return send(res, 404, "Not found");
        return page(game.kind === "doom" ? doomPage(game, lang) : game.kind === "pacman" ? pacmanPage(game, lang) : consolePage(game, lang));
    } catch (err) {
        console.error(err);
        if (!res.headersSent) send(res, 500, "Internal error");
    }
});

if (process.env.NODE_ENV !== "test") {
    server.listen(PORT, () => console.log(`arcade listening on :${PORT}`));
}
