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

export function formatScore(game, value) {
    if (game.score.format === "time") {
        const ms = Math.max(0, Math.round(value));
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${m}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
    }
    return Number(value).toLocaleString("de-DE");
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

function html(res, body) {
    send(res, 200, body, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
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

function scriptTag(game) {
    const attrs = [`src="${asset("arcade.js")}"`, `data-game="${game.id}"`];
    if (game.score) {
        attrs.push(`data-order="${game.score.order}"`, `data-format="${game.score.format}"`, `data-label="${esc(game.score.label)}"`);
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

function layout(title, body) {
    return `<!doctype html>
<html lang="de">
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

function landingPage() {
    const doom = GAMES.filter((g) => g.kind === "doom").map((g) => {
        const scores = top(g, 3);
        const rows = scores.length
            ? scores.map((s, i) => `<li><span>${["🥇", "🥈", "🥉"][i]} ${esc(s.name)}</span><b>${formatScore(g, s.score)}</b></li>`).join("")
            : `<li class="empty">Noch keine Einträge</li>`;
        return `<a class="game" href="/${g.id}/"><strong>${esc(g.title)}</strong><em>${esc(g.description)}</em><ol>${rows}</ol></a>`;
    }).join("");
    const consoles = GAMES.filter((g) => g.kind === "console").map((g) =>
        `<a class="game console" href="/${g.id}/"><strong>${esc(g.title)}</strong><small>${esc(g.extensions.filter((e) => e !== ".zip" && e !== ".7z").join(" "))}</small><em>${esc(g.hint ?? "Eigene ROM laden und losspielen.")}</em></a>`,
    ).join("");
    return layout(TITLE, `<h1>● ${esc(TITLE.toUpperCase())} ●</h1>
<p class="sub">Insert coin – oder einfach klicken.</p>
<main class="grid">${doom}</main>
<h2 class="section">🎮 Konsolen</h2>
<p class="sub">Lade deine eigenen Spiele – die Datei bleibt in deinem Browser, hochgeladen wird nichts.</p>
<main class="grid">${consoles}</main>
<p class="foot"><a href="/scores">Komplette Bestenliste</a> · <a href="/about">Spiele &amp; Lizenzen</a></p>`);
}

function scoresPage() {
    const sections = scoredGames.map((g) => {
        const scores = top(g, 25);
        const rows = scores.length
            ? scores.map((s, i) => `<tr><td>${i + 1}.</td><td>${esc(s.name)}</td><td>${formatScore(g, s.score)}</td><td>${esc(s.date.slice(0, 10))}</td></tr>`).join("")
            : `<tr><td colspan="4" class="empty">Noch keine Einträge</td></tr>`;
        return `<section><h2><a href="/${g.id}/">${esc(g.title)}</a></h2><table><thead><tr><th>#</th><th>Name</th><th>${esc(g.score.label)}</th><th>Datum</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }).join("");
    return layout(`Bestenliste – ${TITLE}`, `<h1>🏆 BESTENLISTE</h1>
<p class="sub"><a href="/">← Zurück zur Arcade</a></p>
<main class="tables">${sections}</main>
<p class="credits">Punkte pro Level: Kills × 100, Items × 20, Secrets × 500, plus 20 pro Sekunde unter Par – mal Schwierigkeit (Baby ×0,5 bis Albtraum ×2). Gezählt wird der Durchgang ab „Neues Spiel“; Cheats oder geladene Spielstände zählen nicht.</p>`);
}

function aboutPage() {
    const rows = [...GAMES.filter((g) => g.author), ...CREDITS].map((g) =>
        `<tr><td>${esc(g.title)}</td><td>${esc(g.author)}</td><td>${esc(g.license)}</td><td><a href="${esc(g.source)}">Quelle</a></td></tr>`,
    ).join("");
    return layout(`Spiele & Lizenzen – ${TITLE}`, `<h1>SPIELE &amp; LIZENZEN</h1>
<p class="sub"><a href="/">← Zurück zur Arcade</a></p>
<main class="tables"><section><table><thead><tr><th>Was</th><th>Von</th><th>Lizenz</th><th>Quelle</th></tr></thead><tbody>${rows}</tbody></table>
<p class="note">Doom (Shareware) und Freedoom werden unverändert und kostenlos bereitgestellt, wie es ihre Lizenzen erlauben. Für die Konsolen stellt die Arcade keine Spiele bereit: ROMs werden ausschließlich im Browser der Spieler geladen und dort gespeichert, der Server sieht sie nie. Der Quellcode der Arcade liegt unter <a href="https://github.com/newtox/wa-arcade">github.com/newtox/wa-arcade</a>.</p></section></main>`);
}

function doomPage(game) {
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(game.title)} – ${esc(TITLE)}</title>
<link rel="stylesheet" href="${asset("landing.css")}">
${scriptTag(game)}
</head>
<body class="doom">
<div id="doom" data-iwad="${esc(game.iwad)}" data-wad-url="/_arcade/wads/${esc(game.iwad)}" data-wasm-url="${asset("doom/doom.wasm")}">
<canvas width="320" height="200" tabindex="0"></canvas>
<div class="doom-start">
<h1>${esc(game.title.toUpperCase())}</h1>
<button type="button">▶ Klicken zum Starten</button>
<dl>
<dt>WASD / Pfeile</dt><dd>Laufen (A/D seitwärts)</dd>
<dt>Maus</dt><dd>Umsehen – ins Bild klicken fängt die Maus, Esc gibt sie frei</dd>
<dt>Strg / Linksklick</dt><dd>Schießen</dd>
<dt>Leertaste / E</dt><dd>Türen &amp; Schalter</dd>
<dt>Shift</dt><dd>Rennen</dd>
<dt>1–7</dt><dd>Waffe wechseln</dd>
<dt>Esc</dt><dd>Menü (Neues Spiel, Speichern, Lautstärke)</dd>
</dl>
<p>Für die Bestenliste zählt jeder geschaffte Level ab „Neues Spiel“. Spielstände und Einstellungen werden in deinem Browser gespeichert.</p>
</div>
</div>
<script type="module" src="${asset("doom/player.js")}"></script>
</body>
</html>`;
}

function consolePage(game) {
    const accept = game.extensions.join(",");
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(game.title)} – ${esc(TITLE)}</title>
<link rel="stylesheet" href="${asset("landing.css")}">
${scriptTag(game)}
</head>
<body class="console-page">
<div id="console" data-system="${esc(game.id)}" data-core="${esc(game.core)}" data-extensions="${esc(accept)}" data-ejs="/_arcade/ejs/">
<div class="picker">
<h1>${esc(game.title.toUpperCase())}</h1>
<p>Lade ein Spiel von deinem Computer. Die Datei bleibt in deinem Browser – hochgeladen wird nichts.${game.hint ? `<br>${esc(game.hint)}` : ""}</p>
<label class="drop"><strong>📂 ROM auswählen oder hierher ziehen</strong><small>${esc(game.extensions.join(" "))}</small><input type="file" accept="${esc(accept)}"></label>
<label class="remember"><input type="checkbox" name="remember" checked> In diesem Browser merken</label>
<div class="status" role="status"></div>
<h2>Deine Spiele</h2>
<ul class="library"><li class="empty">Lädt …</li></ul>
<a class="back" href="/">← Zurück zur Arcade</a>
</div>
<div id="game"></div>
</div>
<script src="${asset("console/console.js")}"></script>
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
        if (pathname === "/" || pathname === "/index.html") return html(res, landingPage());
        if (pathname === "/scores") return html(res, scoresPage());
        if (pathname === "/about") return html(res, aboutPage());

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
        if (rest.length === 0) return send(res, 301, "", { Location: `/${id}/` });
        if (rest.join("/") !== "") return send(res, 404, "Not found");
        return html(res, game.kind === "doom" ? doomPage(game) : consolePage(game));
    } catch (err) {
        console.error(err);
        if (!res.headersSent) send(res, 500, "Internal error");
    }
});

if (process.env.NODE_ENV !== "test") {
    server.listen(PORT, () => console.log(`arcade listening on :${PORT}`));
}
