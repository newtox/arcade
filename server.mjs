import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GAMES, ENGINE_CREDITS } from "./games.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const APP_DIR = path.dirname(new URL(import.meta.url).pathname);
const GAMES_DIR = process.env.GAMES_DIR ?? path.join(APP_DIR, "games");
const ROMS_DIR = process.env.ROMS_DIR ?? path.join(APP_DIR, "roms");
const EJS_DIR = process.env.EJS_DIR ?? path.join(APP_DIR, "emulatorjs");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DATA_DIR = process.env.DATA_DIR ?? path.join(APP_DIR, "data");
const WA_URL = (process.env.WA_URL ?? "").replace(/\/+$/, "");
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS ?? "'self'";
const TITLE = process.env.ARCADE_TITLE ?? "Arcade";

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
    ".nes": "application/octet-stream",
    ".gb": "application/octet-stream",
    ".gbc": "application/octet-stream",
};

function scriptTag(game) {
    const attrs = [`src="/_arcade/arcade.js"`, `data-game="${game.id}"`];
    if (game.score) {
        attrs.push(`data-order="${game.score.order}"`, `data-format="${game.score.format}"`, `data-label="${esc(game.score.label)}"`);
    }
    if (WA_URL) attrs.push(`data-wa="${WA_URL}"`);
    return `<script ${attrs.join(" ")}></script>`;
}

export function transform(game, relPath, content) {
    if (relPath === "index.html") {
        let page = content
            .replace(/<script[^>]*adsbygoogle[^>]*><\/script>/g, "")
            .replace(/<script[^>]*>\s*\/\/analytics[\s\S]*?<\/script>/g, "")
            .replace(/<script>\s*\(function\(i,s,o,g,r,a,m\)[\s\S]*?<\/script>/g, "");
        if (game.id === "hexgl") page = page.replace(/https?:\/\/hexgl\.bkcore\.com\/(favicon|image)\.png/g, "favicon.png");
        const tag = scriptTag(game);
        page = /<head[^>]*>/i.test(page) ? page.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`) : tag + page;
        return page;
    }
    if (game.id === "spacehuggers" && relPath === "appLevel.js") {
        return content.replace(
            /const resetGame=\(\)=>\s*\{/,
            "$& if (level && window.arcadeGameOver) window.arcadeGameOver(totalKills);",
        );
    }
    return content;
}

async function serveFile(res, filePath, transformFn) {
    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch {
        return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
    }
    if (stat.isDirectory()) return serveFile(res, path.join(filePath, "index.html"), transformFn);
    const type = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    if (transformFn && (type.startsWith("text/html") || type.startsWith("text/javascript"))) {
        const content = transformFn(await fs.readFile(filePath, "utf8"));
        return send(res, 200, content, { "Content-Type": type, "Cache-Control": "no-cache" });
    }
    const data = await fs.readFile(filePath);
    return send(res, 200, data, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function layout(title, body) {
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/_arcade/landing.css">
</head>
<body>
${body}
</body>
</html>`;
}

function landingPage() {
    const web = GAMES.filter((g) => g.kind === "web").map((g) => {
        const scores = top(g, 3);
        const rows = scores.length
            ? scores.map((s, i) => `<li><span>${["🥇", "🥈", "🥉"][i]} ${esc(s.name)}</span><b>${formatScore(g, s.score)}</b></li>`).join("")
            : `<li class="empty">Noch keine Einträge</li>`;
        return `<a class="game" href="/${g.id}/"><strong>${esc(g.title)}</strong><em>${esc(g.description)}</em><ol>${rows}</ol></a>`;
    }).join("");
    const retro = GAMES.filter((g) => g.kind === "retro").map((g) =>
        `<a class="game retro" href="/${g.id}/"><strong>${esc(g.title)}</strong><small>${esc(g.system)} · ${esc(g.players)}</small><em>${esc(g.description)}</em></a>`,
    ).join("");
    return layout(TITLE, `<h1>● ${esc(TITLE.toUpperCase())} ●</h1>
<p class="sub">Insert coin – oder einfach klicken.</p>
<main class="grid">${web}</main>
<h2 class="section">🕹️ Retro-Ecke</h2>
<p class="sub">Homebrew-Spiele für NES und Game Boy – frei verfügbar von ihren Entwicklern.</p>
<main class="grid">${retro}</main>
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
<main class="tables">${sections}</main>`);
}

function aboutPage() {
    const rows = [...GAMES, ...ENGINE_CREDITS].map((g) =>
        `<tr><td>${esc(g.title)}</td><td>${esc(g.author)}</td><td>${esc(g.license)}</td><td><a href="${esc(g.source)}">Quellcode</a></td></tr>`,
    ).join("");
    return layout(`Spiele & Lizenzen – ${TITLE}`, `<h1>SPIELE &amp; LIZENZEN</h1>
<p class="sub"><a href="/">← Zurück zur Arcade</a></p>
<main class="tables"><section><table><thead><tr><th>Spiel</th><th>Von</th><th>Lizenz</th><th>Quelle</th></tr></thead><tbody>${rows}</tbody></table>
<p class="note">Alle Spiele werden unter den genannten Lizenzen ihrer Entwickler bereitgestellt. Die Arcade entfernt eingebettetes Tracking und fügt nur Lautstärkeregler und Bestenliste hinzu; der Quellcode der Arcade selbst liegt unter <a href="https://github.com/newtox/arcade">github.com/newtox/arcade</a>.</p></section></main>`);
}

function retroPage(game) {
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(game.title)} – ${esc(TITLE)}</title>
${scriptTag(game)}
<style>html,body{margin:0;height:100%;background:#000}#game{width:100%;height:100%}</style>
</head>
<body>
<div id="game"></div>
<script>
EJS_player = "#game";
EJS_core = ${JSON.stringify(game.core)};
EJS_gameUrl = ${JSON.stringify(`/_arcade/roms/${game.rom}`)};
EJS_gameName = ${JSON.stringify(game.title)};
EJS_pathtodata = "/_arcade/ejs/";
EJS_language = "de-GER";
EJS_volume = 1;
EJS_color = "#ff4fa3";
</script>
<script src="/_arcade/ejs/loader.js"></script>
</body>
</html>`;
}

export const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = decodeURIComponent(url.pathname);

        if (pathname === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });
        if (pathname.startsWith("/_arcade/api/")) return handleApi(req, res, url);
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
        if (pathname === "/" || pathname === "/index.html") return html(res, landingPage());
        if (pathname === "/scores") return html(res, scoresPage());
        if (pathname === "/about") return html(res, aboutPage());

        const parts = pathname.split("/");
        if (parts.some((part) => part.startsWith(".") || part === "..")) return send(res, 404, "Not found");

        if (pathname.startsWith("/_arcade/ejs/")) {
            return serveFile(res, path.join(EJS_DIR, pathname.slice("/_arcade/ejs/".length)));
        }
        if (pathname.startsWith("/_arcade/roms/")) {
            const rom = pathname.slice("/_arcade/roms/".length);
            if (!GAMES.some((g) => g.rom === rom)) return send(res, 404, "Not found");
            return serveFile(res, path.join(ROMS_DIR, rom));
        }
        if (pathname.startsWith("/_arcade/")) {
            return serveFile(res, path.join(PUBLIC_DIR, pathname.slice("/_arcade/".length)));
        }

        const [, id, ...rest] = parts;
        const game = gameById.get(id);
        if (!game) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
        if (rest.length === 0) return send(res, 301, "", { Location: `/${id}/` });

        if (game.kind === "retro") {
            if (rest.join("/") === "") return html(res, retroPage(game));
            return send(res, 404, "Not found");
        }

        let rel = rest.join("/");
        if (rel === "" || rel.endsWith("/")) rel += "index.html";
        const filePath = path.join(GAMES_DIR, id, rel);
        if (!filePath.startsWith(path.join(GAMES_DIR, id) + path.sep)) return send(res, 404, "Not found");
        return serveFile(res, filePath, (content) => transform(game, rel, content));
    } catch (err) {
        console.error(err);
        if (!res.headersSent) send(res, 500, "Internal error");
    }
});

if (process.env.NODE_ENV !== "test") {
    server.listen(PORT, () => console.log(`arcade listening on :${PORT}`));
}
