// Doom player for the arcade: runs doom.wasm (doomgeneric + WASI) on a canvas,
// plays sound effects and OPL music through Web Audio and reports finished
// levels to the leaderboard.
import { WASI, File, Directory, OpenFile, ConsoleStdout, PreopenDirectory } from "../vendor/wasi/index.js";

const root = document.getElementById("doom");
const cfg = root.dataset;
const canvas = root.querySelector("canvas");
const overlay = root.querySelector(".doom-start");
const screen = canvas.getContext("2d", { alpha: false });
const image = screen.createImageData(320, 200);
const pixels32 = new Uint32Array(image.data.buffer);

// ---------- Saved files (config, savegames) in IndexedDB ----------

const DB_NAME = "arcade-doom";
function idb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("files");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function loadSaved(prefix) {
    try {
        const db = await idb();
        return await new Promise((resolve) => {
            const out = [];
            const req = db.transaction("files").objectStore("files").openCursor();
            req.onsuccess = () => {
                const cur = req.result;
                if (!cur) return resolve(out);
                if (String(cur.key).startsWith(prefix)) out.push([String(cur.key).slice(prefix.length), cur.value]);
                cur.continue();
            };
            req.onerror = () => resolve(out);
        });
    } catch {
        return [];
    }
}
async function storeSaved(prefix, entries) {
    try {
        const db = await idb();
        const tx = db.transaction("files", "readwrite");
        for (const [name, data] of entries) tx.objectStore("files").put(data, prefix + name);
    } catch {}
}

// ---------- Leaderboard ----------

const SKILL_FACTOR = [0.5, 0.75, 1, 1.5, 2];
const DE = document.documentElement.lang === "de";
const tr = (de, en) => (DE ? de : en);
const SKILL_NAME = DE ? ["Baby", "Leicht", "Normal", "Schwer", "Albtraum"] : ["Baby", "Easy", "Normal", "Hard", "Nightmare"];
let run = null;

const fmt = (n) => Number(n).toLocaleString(DE ? "de-DE" : "en-GB");
const clock = (tics) => {
    const s = Math.floor(tics / 35);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const toast = (text) => (window.arcadeToast ? window.arcadeToast(text) : console.log(text));

function newGame(skill, episode) {
    run = { skill, episode, total: 0, ranked: true };
}

function unranked(reason) {
    if (!run) run = { skill: 2, episode: 1, total: 0, ranked: false };
    if (!run.ranked) return;
    run.ranked = false;
    toast(reason === 1
        ? tr("Spielstand geladen – dieser Durchgang zählt nicht für die Bestenliste. Starte ein neues Spiel für die Wertung.",
             "Savegame loaded – this run does not count for the leaderboard. Start a new game to be ranked.")
        : tr("Cheat benutzt – dieser Durchgang zählt nicht für die Bestenliste.", "Cheat used – this run does not count for the leaderboard."));
}

function levelDone(skill, episode, map, next, kills, maxKills, items, maxItems, secrets, maxSecrets, tics, parTics) {
    if (!run) return;
    const timeBonus = parTics > 0 && tics < parTics ? Math.floor((parTics - tics) / 35) * 20 : 0;
    const points = Math.round((kills * 100 + items * 20 + secrets * 500 + timeBonus) * (SKILL_FACTOR[skill] ?? 1));
    run.total += points;
    const final = map === 8;
    const text =
        tr(`E${episode}M${map} geschafft: +${fmt(points)} Punkte · Gesamt ${fmt(run.total)}\n`,
           `E${episode}M${map} done: +${fmt(points)} points · total ${fmt(run.total)}\n`) +
        `Kills ${kills}/${maxKills} · Items ${items}/${maxItems} · Secrets ${secrets}/${maxSecrets} · ` +
        `${tr("Zeit", "Time")} ${clock(tics)}${parTics ? ` (Par ${clock(parTics)})` : ""} · ${SKILL_NAME[skill] ?? ""}`;
    if (run.ranked && window.arcadeGameOver) window.arcadeGameOver(run.total, { toast: text, final });
    else toast(text + "\n" + tr("(ohne Wertung)", "(not ranked)"));
}

// ---------- Audio ----------

let audio = null;
let sfxBus = null;
const sfxCache = new Map();
const channels = new Map();
let memory = null;
let exports = null;

function setupAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio = new Ctx();
    sfxBus = audio.createGain();
    sfxBus.gain.value = 0.8;
    sfxBus.connect(audio.destination);

    const music = audio.createScriptProcessor(4096, 0, 2);
    const musicGain = audio.createGain();
    musicGain.gain.value = 0.9;
    music.onaudioprocess = (e) => {
        const left = e.outputBuffer.getChannelData(0);
        const right = e.outputBuffer.getChannelData(1);
        if (!exports || !started) {
            left.fill(0);
            right.fill(0);
            return;
        }
        const frames = left.length;
        const ptr = exports.dg_music_render(frames);
        const pcm = new Int16Array(memory.buffer, ptr, frames * 2);
        for (let i = 0; i < frames; i++) {
            left[i] = pcm[i * 2] / 32768;
            right[i] = pcm[i * 2 + 1] / 32768;
        }
    };
    music.connect(musicGain);
    musicGain.connect(audio.destination);
}

function decodeSfx(lump, ptr, length) {
    if (sfxCache.has(lump)) return sfxCache.get(lump);
    let buffer = null;
    const view = new DataView(memory.buffer, ptr, length);
    if (length > 8 && view.getUint16(0, true) === 3) {
        const rate = view.getUint16(2, true);
        let count = Math.min(view.getUint32(4, true), length - 8);
        let start = 8;
        if (count > 32) {
            start += 16;
            count -= 32;
        }
        if (count > 0 && rate >= 3000) {
            const bytes = new Uint8Array(memory.buffer, ptr + start, count);
            buffer = audio.createBuffer(1, count, rate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < count; i++) data[i] = (bytes[i] - 128) / 128;
        }
    }
    sfxCache.set(lump, buffer);
    return buffer;
}

function stopChannel(ch) {
    const c = channels.get(ch);
    if (!c) return;
    c.playing = false;
    try {
        c.src.stop();
    } catch {}
    channels.delete(ch);
}

function setParams(c, vol, sep) {
    c.gain.gain.value = Math.max(0, Math.min(127, vol)) / 127;
    if (c.pan) c.pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 127));
}

function sfxStart(ch, lump, ptr, length, vol, sep) {
    if (!audio) return -1;
    const buffer = decodeSfx(lump, ptr, length);
    stopChannel(ch);
    if (!buffer) return -1;
    const src = audio.createBufferSource();
    src.buffer = buffer;
    const gain = audio.createGain();
    const pan = audio.createStereoPanner ? audio.createStereoPanner() : null;
    src.connect(gain);
    if (pan) {
        gain.connect(pan);
        pan.connect(sfxBus);
    } else gain.connect(sfxBus);
    const c = { src, gain, pan, playing: true };
    setParams(c, vol, sep);
    src.onended = () => {
        c.playing = false;
        if (channels.get(ch) === c) channels.delete(ch);
    };
    channels.set(ch, c);
    src.start();
    return ch;
}

// ---------- Input ----------

const KEY = {
    ArrowRight: 0xae, ArrowLeft: 0xac, ArrowUp: 0xad, ArrowDown: 0xaf,
    KeyW: 0xad, KeyS: 0xaf, KeyA: 0xa0, KeyD: 0xa1, Comma: 0xa0, Period: 0xa1,
    ControlLeft: 0xa3, ControlRight: 0xa3, Space: 0xa2, KeyE: 0xa2,
    ShiftLeft: 0x80 + 0x36, ShiftRight: 0x80 + 0x36, AltLeft: 0x80 + 0x38, AltRight: 0x80 + 0x38,
    Escape: 27, Enter: 13, NumpadEnter: 13, Tab: 9, Backspace: 0x7f, Pause: 0xff,
    Minus: 0x2d, Equal: 0x3d, NumpadSubtract: 0x2d, NumpadAdd: 0x3d,
    F1: 0xbb, F2: 0xbc, F3: 0xbd, F4: 0xbe, F5: 0xbf, F6: 0xc0, F7: 0xc1, F8: 0xc2, F9: 0xc3, F10: 0xc4, F11: 0xd7, F12: 0xd8,
};

function doomKey(e) {
    if (e.code in KEY) return KEY[e.code];
    if (/^Key[A-Z]$/.test(e.code)) return e.code.charCodeAt(3) + 32; // lowercase ASCII
    if (/^Digit[0-9]$/.test(e.code)) return e.code.charCodeAt(5);
    if (/^Numpad[0-9]$/.test(e.code)) return e.code.charCodeAt(6);
    return 0;
}

function onKey(e, pressed) {
    if (!started) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (t && t.closest && t.closest(".arcade-bar, .arcade-panel, .arcade-dialog")) return;
    const key = doomKey(e) || (e.key.length === 1 && e.key.charCodeAt(0) < 128 ? e.key.toLowerCase().charCodeAt(0) : 0);
    if (!key) return;
    e.preventDefault();
    if (e.repeat) return;
    const typed = e.key.length === 1 && e.key.charCodeAt(0) < 128 ? e.key.charCodeAt(0) : 0;
    exports.dg_key(pressed ? 1 : 0, key, typed);
}
window.addEventListener("keydown", (e) => onKey(e, true));
window.addEventListener("keyup", (e) => onKey(e, false));

let buttons = 0;
canvas.addEventListener("mousedown", (e) => {
    if (!started) return;
    if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock?.();
        return;
    }
    buttons = e.buttons & 7;
    exports.dg_mouse(buttons, 0, 0);
});
window.addEventListener("mouseup", (e) => {
    if (!started || document.pointerLockElement !== canvas) return;
    buttons = e.buttons & 7;
    exports.dg_mouse(buttons, 0, 0);
});
window.addEventListener("mousemove", (e) => {
    if (!started || document.pointerLockElement !== canvas) return;
    const dx = Math.round(e.movementX * 2);
    if (dx) exports.dg_mouse(buttons, dx, 0);
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- Time (paused while the tab is hidden) ----------

let hiddenSince = null;
let hiddenTotal = 0;
document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenSince = performance.now();
    else if (hiddenSince !== null) {
        hiddenTotal += performance.now() - hiddenSince;
        hiddenSince = null;
    }
});
const now = () => (hiddenSince ?? performance.now()) - hiddenTotal;

// ---------- Engine ----------

const cString = (ptr) => {
    const bytes = new Uint8Array(memory.buffer, ptr);
    let end = 0;
    while (bytes[end]) end++;
    return new TextDecoder().decode(bytes.subarray(0, end));
};

let started = false;
const prefix = `${cfg.iwad}/`;
const wadPromise = fetch(cfg.wadUrl).then((r) => {
    if (!r.ok) throw new Error(`WAD ${r.status}`);
    return r.arrayBuffer();
});
const wasmPromise = WebAssembly.compileStreaming
    ? WebAssembly.compileStreaming(fetch(cfg.wasmUrl))
    : fetch(cfg.wasmUrl).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b));
const savedPromise = loadSaved(prefix);

Promise.all([wadPromise, wasmPromise]).then(
    () => overlay.classList.add("ready"),
    (err) => {
        overlay.querySelector("button").textContent = "Laden fehlgeschlagen";
        console.error(err);
    },
);

async function start() {
    if (started) return;
    overlay.querySelector("button").disabled = true;
    setupAudio();
    const [wad, module, saved] = await Promise.all([wadPromise, wasmPromise, savedPromise]);

    const dir = new PreopenDirectory("/", [
        [cfg.iwad, new File(new Uint8Array(wad), { readonly: true })],
        ["tmp", new Directory([])],
    ]);
    for (const [path, data] of saved) {
        const parts = path.split("/");
        let node = dir.dir;
        for (const part of parts.slice(0, -1)) {
            if (!node.contents.has(part)) node.contents.set(part, new Directory([]));
            node = node.contents.get(part);
        }
        node.contents.set(parts[parts.length - 1], new File(new Uint8Array(data)));
    }
    const wasi = new WASI(["doom"], [], [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered((line) => console.log("[doom]", line)),
        ConsoleStdout.lineBuffered((line) => console.warn("[doom]", line)),
        dir,
    ], { debug: false });

    const instance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: wasi.wasiImport,
        env: {
            js_now_ms: now,
            js_draw(ptr, w, h) {
                const src = new Uint32Array(memory.buffer, ptr, w * h);
                for (let i = 0; i < src.length; i++) {
                    const p = src[i];
                    pixels32[i] = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff);
                }
                screen.putImageData(image, 0, 0);
            },
            js_title: (ptr) => {
                if (ptr) document.title = `${cString(ptr)} – Arcade`;
            },
            js_sfx_start: sfxStart,
            js_sfx_update(ch, vol, sep) {
                const c = channels.get(ch);
                if (c) setParams(c, vol, sep);
            },
            js_sfx_stop: stopChannel,
            js_sfx_playing: (ch) => (channels.get(ch)?.playing ? 1 : 0),
            js_level_done: levelDone,
            js_new_game: newGame,
            js_unranked: unranked,
        },
    });
    memory = instance.exports.memory;
    exports = instance.exports;
    window.doomEngine = exports;
    wasi.initialize(instance);

    overlay.remove();
    canvas.focus();
    started = true;
    exports.dg_start(cfg.iwad === "freedoom1.wad" ? 1 : 0, audio ? audio.sampleRate : 44100);

    // Persist config and savegames every few seconds when they change.
    const seen = new Map();
    const fingerprint = (data) => {
        let h = 2166136261;
        for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619);
        return `${data.length}:${h >>> 0}`;
    };
    // Everything except the IWAD and /tmp: config files and the .savegame folder.
    const walk = (node, base, out) => {
        for (const [name, entry] of node.contents) {
            const path = base + name;
            if (path === cfg.iwad || path === "tmp") continue;
            if (entry instanceof Directory) walk(entry, path + "/", out);
            else if (entry instanceof File) out.push([path, entry]);
        }
        return out;
    };
    const persist = () => {
        const changed = [];
        for (const [path, entry] of walk(dir.dir, "", [])) {
            const fp = fingerprint(entry.data);
            if (seen.get(path) !== fp) {
                seen.set(path, fp);
                changed.push([path, entry.data.slice().buffer]);
            }
        }
        if (changed.length) storeSaved(prefix, changed);
    };
    for (const [path, entry] of walk(dir.dir, "", [])) seen.set(path, fingerprint(entry.data));
    setInterval(persist, 5000);
    window.addEventListener("pagehide", persist);

    const frame = () => {
        try {
            exports.dg_tick();
        } catch (err) {
            console.error(err);
            toast(tr("Doom ist abgestürzt – Seite neu laden.", "Doom crashed – reload the page."));
            return;
        }
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}

overlay.addEventListener("click", start);
window.addEventListener("keydown", (e) => {
    if (!started && overlay.classList.contains("ready") && (e.code === "Enter" || e.code === "Space")) {
        e.preventDefault();
        start();
    }
});
