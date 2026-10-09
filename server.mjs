import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT ?? 8080);
const APP_DIR = path.dirname(new URL(import.meta.url).pathname);
const GAMES_DIR = process.env.GAMES_DIR ?? path.join(APP_DIR, "games");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DATA_DIR = process.env.DATA_DIR ?? path.join(APP_DIR, "data");
const WA_URL = (process.env.WA_URL ?? "").replace(/\/+$/, "");
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS ?? "'self'";
const TITLE = process.env.ARCADE_TITLE ?? "Arcade";

export const GAMES = [
    { id: "2048", title: "2048", description: "Zahlen schieben, bis 2048 erscheint.", maxScore: 10_000_000 },
    { id: "pacman", title: "Pac-Man", description: "Der Klassiker. Geistern ausweichen.", maxScore: 10_000_000 },
    { id: "tetris", title: "Tetris", description: "Reihen voll machen.", maxScore: 10_000_000 },
    { id: "hextris", title: "Hextris", description: "Tetris im Sechseck.", maxScore: 10_000_000 },
];
const gameById = new Map(GAMES.map((g) => [g.id, g]));

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
    CREATE INDEX IF NOT EXISTS scores_game_score ON scores (game, score DESC);
`);

const topStatement = db.prepare(`
    SELECT name, MAX(score) AS score, MIN(created_at) AS created_at
    FROM scores WHERE game = ?
    GROUP BY name ORDER BY score DESC, created_at ASC LIMIT ?
`);
const insertStatement = db.prepare("INSERT INTO scores (game, name, score) VALUES (?, ?, ?)");
const rankStatement = db.prepare(`
    SELECT COUNT(*) AS better FROM (
        SELECT name, MAX(score) AS best FROM scores WHERE game = ? GROUP BY name
    ) WHERE best > ?
`);

export function top(game, limit = 10) {
    return topStatement.all(game, limit).map((r) => ({ name: r.name, score: r.score, date: r.created_at }));
}

export function cleanName(raw) {
    if (typeof raw !== "string") return null;
    const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
    return name.length > 0 ? name : null;
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

async function handleApi(req, res, url) {
    if (url.pathname === "/_arcade/api/scores" && req.method === "GET") {
        const game = url.searchParams.get("game");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 100);
        if (game) {
            if (!gameById.has(game)) return json(res, 404, { error: "unknown game" });
            return json(res, 200, { game, scores: top(game, limit) });
        }
        return json(res, 200, { games: GAMES.map((g) => ({ id: g.id, title: g.title, scores: top(g.id, limit) })) });
    }

    if (url.pathname === "/_arcade/api/scores" && req.method === "POST") {
        let data;
        try {
            data = JSON.parse(await readBody(req));
        } catch {
            return json(res, 400, { error: "invalid body" });
        }
        const game = gameById.get(data?.game);
        const name = cleanName(data?.name);
        const score = Number(data?.score);
        if (!game) return json(res, 400, { error: "unknown game" });
        if (!name) return json(res, 400, { error: "invalid name" });
        if (!Number.isInteger(score) || score < 0 || score > game.maxScore) return json(res, 400, { error: "invalid score" });

        const key = `${clientIp(req)}|${game.id}`;
        const now = Date.now();
        if (now - (lastSubmit.get(key) ?? 0) < 3000) return json(res, 429, { error: "too many requests" });
        lastSubmit.set(key, now);
        if (lastSubmit.size > 10_000) lastSubmit.clear();

        if (score > 0) insertStatement.run(game.id, name, score);
        const { better } = rankStatement.get(game.id, score);
        return json(res, 201, { game: game.id, name, score, rank: better + 1, scores: top(game.id, 10) });
    }

    return json(res, 404, { error: "not found" });
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
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
};

const injectTag = (game) =>
    `<script src="/_arcade/arcade.js" data-game="${game}"${WA_URL ? ` data-wa="${WA_URL}"` : ""}></script>`;

export function transform(game, relPath, content) {
    if (relPath === "index.html") {
        let html = content;
        if (game === "hextris") {
            html = html
                .replace(/<script[^>]*adsbygoogle[^>]*><\/script>/g, "")
                .replace(/<script>\s*\(function\(i,s,o,g,r,a,m\)[\s\S]*?<\/script>/g, "");
        }
        return html.includes("</body>") ? html.replace("</body>", `${injectTag(game)}\n</body>`) : html + injectTag(game);
    }
    if (game === "pacman" && relPath === "pacman.js") {
        return content.replace(
            /(user\.loseLife\(\);\s*if \(user\.getLives\(\) > 0\) \{\s*startLevel\(\);\s*\})/,
            "$1 else if (window.arcadeGameOver) { window.arcadeGameOver(user.theScore()); }",
        );
    }
    if (game === "hextris" && relPath === "js/main.js") {
        return content.replace(/\$\.get\('http:\/\/[^']*' \+ String\(score\)\);?/, "");
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
    return send(res, 200, data, { "Content-Type": type, "Cache-Control": "public, max-age=3600" });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function landingPage() {
    const cards = GAMES.map((g) => {
        const scores = top(g.id, 3);
        const rows = scores.length
            ? scores.map((s, i) => `<li><span>${["🥇", "🥈", "🥉"][i]} ${esc(s.name)}</span><b>${s.score.toLocaleString("de-DE")}</b></li>`).join("")
            : `<li class="empty">Noch keine Punkte</li>`;
        return `<a class="game" href="/${g.id}/"><strong>${esc(g.title)}</strong><em>${esc(g.description)}</em><ol>${rows}</ol></a>`;
    }).join("");
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<link rel="stylesheet" href="/_arcade/landing.css">
</head>
<body>
<h1>● ${esc(TITLE.toUpperCase())} ●</h1>
<p class="sub">Insert coin – oder einfach klicken.</p>
<main class="grid">${cards}</main>
<p class="foot"><a href="/scores">Komplette Bestenliste</a></p>
<p class="credits">Spiele: <a href="https://github.com/gabrielecirulli/2048">2048</a> (MIT) ·
<a href="https://github.com/daleharvey/pacman">Pac-Man</a> (WTFPL) ·
<a href="https://github.com/jakesgordon/javascript-tetris">Tetris</a> (MIT) ·
<a href="https://github.com/Hextris/hextris">Hextris</a> (GPL-3.0)</p>
</body>
</html>`;
}

function scoresPage() {
    const sections = GAMES.map((g) => {
        const scores = top(g.id, 25);
        const rows = scores.length
            ? scores.map((s, i) => `<tr><td>${i + 1}.</td><td>${esc(s.name)}</td><td>${s.score.toLocaleString("de-DE")}</td><td>${esc(s.date.slice(0, 10))}</td></tr>`).join("")
            : `<tr><td colspan="4" class="empty">Noch keine Punkte</td></tr>`;
        return `<section><h2><a href="/${g.id}/">${esc(g.title)}</a></h2><table><thead><tr><th>#</th><th>Name</th><th>Punkte</th><th>Datum</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }).join("");
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bestenliste – ${esc(TITLE)}</title>
<link rel="stylesheet" href="/_arcade/landing.css">
</head>
<body>
<h1>🏆 BESTENLISTE</h1>
<p class="sub"><a href="/">← Zurück zur Arcade</a></p>
<main class="tables">${sections}</main>
</body>
</html>`;
}

function html(res, body) {
    send(res, 200, body, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
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

        if (pathname.split("/").some((part) => part.startsWith(".") || part === "..")) {
            return send(res, 404, "Not found");
        }

        if (pathname.startsWith("/_arcade/")) {
            return serveFile(res, path.join(PUBLIC_DIR, pathname.slice("/_arcade/".length)));
        }

        const [, game, ...rest] = pathname.split("/");
        if (!gameById.has(game)) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
        if (rest.length === 0) return send(res, 301, "", { Location: `/${game}/` });

        let rel = rest.join("/");
        if (rel === "" || rel.endsWith("/")) rel += "index.html";
        const filePath = path.join(GAMES_DIR, game, rel);
        if (!filePath.startsWith(path.join(GAMES_DIR, game) + path.sep)) return send(res, 404, "Not found");
        return serveFile(res, filePath, (content) => transform(game, rel, content));
    } catch (err) {
        console.error(err);
        if (!res.headersSent) send(res, 500, "Internal error");
    }
});

if (process.env.NODE_ENV !== "test") {
    server.listen(PORT, () => console.log(`arcade listening on :${PORT}`));
}
