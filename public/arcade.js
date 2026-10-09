(function () {
    "use strict";

    var script = document.currentScript;
    var data = (script && script.dataset) || {};
    var GAME = data.game;
    var WA_URL = data.wa;
    var SCORED = !!data.order;
    var ORDER = data.order || "desc";
    var FORMAT = data.format || "number";
    if (!GAME) return;

    var store = {
        get: function (key, fallback) {
            try {
                var value = localStorage.getItem("arcade." + key);
                return value === null ? fallback : value;
            } catch (e) {
                return fallback;
            }
        },
        set: function (key, value) {
            try {
                localStorage.setItem("arcade." + key, value);
            } catch (e) {}
        },
    };

    function formatScore(value) {
        if (FORMAT === "time") {
            var ms = Math.max(0, Math.round(Number(value)));
            var m = Math.floor(ms / 60000);
            var s = Math.floor((ms % 60000) / 1000);
            return m + ":" + String(s).padStart(2, "0") + "." + String(ms % 1000).padStart(3, "0");
        }
        return Number(value).toLocaleString("de-DE");
    }

    // ---------- Volume (HTML audio + Web Audio) ----------

    var volume = Number(store.get("volume", "0.3"));
    if (!(volume >= 0 && volume <= 1)) volume = 0.3;
    var muted = store.get("muted", "false") === "true";
    var media = new Set();
    var masters = [];

    function effective() {
        return muted ? 0 : volume;
    }

    function applyMedia(el) {
        try {
            el.volume = volume;
            el.muted = muted;
        } catch (e) {}
    }

    function applyAll() {
        media.forEach(applyMedia);
        masters.forEach(function (g) {
            try {
                g.gain.value = effective();
            } catch (e) {}
        });
    }

    var originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        media.add(this);
        applyMedia(this);
        return originalPlay.apply(this, arguments);
    };

    if (window.AudioNode && window.AudioDestinationNode) {
        var originalConnect = AudioNode.prototype.connect;
        var masterOf = new WeakMap();
        var masterFor = function (ctx) {
            var gain = masterOf.get(ctx);
            if (!gain) {
                gain = ctx.createGain();
                gain.gain.value = effective();
                originalConnect.call(gain, ctx.destination);
                masterOf.set(ctx, gain);
                masters.push(gain);
            }
            return gain;
        };
        AudioNode.prototype.connect = function (target) {
            if (target instanceof AudioDestinationNode && masterOf.get(target.context) !== this) {
                var args = Array.prototype.slice.call(arguments);
                args[0] = masterFor(target.context);
                originalConnect.apply(this, args);
                return target;
            }
            return originalConnect.apply(this, arguments);
        };
    }

    function setVolume(v, m) {
        volume = v;
        muted = m;
        store.set("volume", String(v));
        store.set("muted", String(m));
        applyAll();
        renderBar();
    }

    // ---------- Player name ----------

    var playerName = null;
    var namePromise = null;

    function loadWaName() {
        return new Promise(function (resolve) {
            if (window.parent === window || !WA_URL) return resolve(null);
            var timer = setTimeout(function () {
                resolve(null);
            }, 3000);
            var s = document.createElement("script");
            s.src = WA_URL + "/iframe_api.js";
            s.onload = function () {
                if (!window.WA || !window.WA.onInit) {
                    clearTimeout(timer);
                    return resolve(null);
                }
                window.WA.onInit()
                    .then(function () {
                        clearTimeout(timer);
                        resolve(window.WA.player && window.WA.player.name ? String(window.WA.player.name) : null);
                    })
                    .catch(function () {
                        clearTimeout(timer);
                        resolve(null);
                    });
            };
            s.onerror = function () {
                clearTimeout(timer);
                resolve(null);
            };
            document.head.appendChild(s);
        });
    }

    function resolveName() {
        if (!namePromise) {
            namePromise = loadWaName().then(function (waName) {
                playerName = waName || store.get("name", null);
                renderBar();
                return playerName;
            });
        }
        return namePromise;
    }

    function stopKeys(node) {
        ["keydown", "keyup", "keypress"].forEach(function (type) {
            node.addEventListener(type, function (e) {
                e.stopPropagation();
            });
        });
    }

    function askName() {
        if (document.exitPointerLock && document.pointerLockElement) document.exitPointerLock();
        return new Promise(function (resolve) {
            var dialog = el("div", "arcade-dialog");
            dialog.innerHTML =
                '<form><label>Dein Name für die Bestenliste</label>' +
                '<input name="name" maxlength="24" autocomplete="nickname" required>' +
                '<div><button type="button" data-skip>Nicht eintragen</button><button type="submit">Eintragen</button></div></form>';
            var input = dialog.querySelector("input");
            input.value = playerName || "";
            dialog.querySelector("form").addEventListener("submit", function (e) {
                e.preventDefault();
                var name = input.value.replace(/[<>]/g, "").trim().slice(0, 24);
                if (!name) return;
                playerName = name;
                store.set("name", name);
                dialog.remove();
                renderBar();
                resolve(name);
            });
            dialog.querySelector("[data-skip]").addEventListener("click", function () {
                dialog.remove();
                resolve(null);
            });
            stopKeys(dialog);
            document.body.appendChild(dialog);
            setTimeout(function () {
                input.focus();
            }, 50);
        });
    }

    // ---------- Scores ----------

    var lastReport = { score: -1, time: 0 };

    function api(method, query, body) {
        return fetch("/_arcade/api/scores" + (query || ""), {
            method: method,
            headers: body ? { "Content-Type": "application/json" } : {},
            body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) {
            return r.json().then(function (d) {
                if (!r.ok) throw new Error(d.error || "request failed");
                return d;
            });
        });
    }

    // opts.toast: show a small non-blocking message instead of the leaderboard panel
    // opts.final: show the leaderboard panel (end of a run)
    window.arcadeGameOver = function (rawScore, opts) {
        opts = opts || {};
        if (!SCORED) return;
        var score = Math.round(Number(rawScore));
        if (!(score > 0)) return;
        var now = Date.now();
        if (score === lastReport.score && now - lastReport.time < 5000) return;
        lastReport = { score: score, time: now };

        resolveName()
            .then(function (name) {
                return name || askName();
            })
            .then(function (name) {
                if (!name) {
                    if (opts.toast && !opts.final) return showToast(opts.toast + "\n(nicht eingetragen)");
                    return showBoard(null);
                }
                return api("POST", "", { game: GAME, name: name, score: score }).then(
                    function (result) {
                        if (opts.toast) showToast(opts.toast + "\nPlatz " + result.rank + " in der Bestenliste");
                        if (!opts.toast || opts.final) showBoard(result);
                    },
                    function () {
                        if (opts.toast) showToast(opts.toast + "\nBestenliste gerade nicht erreichbar");
                        else showBoard(null);
                    },
                );
            });
    };

    window.arcadeToast = function (text) {
        showToast(text);
    };

    // ---------- UI ----------

    function el(tag, className) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        return e;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    var css =
        ".arcade-bar{position:fixed;top:8px;right:8px;z-index:2147483646;display:flex;gap:6px;align-items:center;" +
        "font:13px ui-monospace,monospace;color:#f3eefc;background:rgba(20,17,31,.85);border:2px solid #3d3360;padding:4px 8px;border-radius:6px}" +
        ".arcade-bar button{all:unset;cursor:pointer;padding:2px 4px;font-size:15px;line-height:1}" +
        ".arcade-bar input[type=range]{width:70px;accent-color:#ff4fa3}" +
        ".arcade-bar .who{opacity:.75;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".arcade-panel,.arcade-dialog{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);font:15px ui-monospace,monospace}" +
        ".arcade-panel>div,.arcade-dialog>form{background:#221c35;color:#f3eefc;border:3px solid #ff4fa3;box-shadow:6px 6px 0 #000;padding:18px 20px;min-width:260px;max-width:90vw}" +
        ".arcade-panel h3{margin:0 0 10px;color:#ff4fa3}.arcade-panel ol{margin:0;padding-left:28px}.arcade-panel li{padding:2px 0}" +
        ".arcade-panel li.me{color:#ffd84f;font-weight:bold}.arcade-panel li span{float:right;margin-left:16px}" +
        ".arcade-panel p{margin:10px 0 0;color:#a99cc9}.arcade-panel button,.arcade-dialog button{margin-top:12px;background:#ff4fa3;color:#14111f;border:0;padding:6px 12px;font:inherit;cursor:pointer}" +
        ".arcade-dialog label{display:block;margin-bottom:8px}.arcade-dialog input{width:100%;box-sizing:border-box;padding:6px;font:inherit;background:#14111f;color:#f3eefc;border:2px solid #3d3360}" +
        ".arcade-dialog div{display:flex;gap:8px;justify-content:flex-end}.arcade-dialog [data-skip]{background:#3d3360;color:#f3eefc}" +
        ".arcade-toasts{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483645;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;max-width:92vw}" +
        ".arcade-toast{background:rgba(20,17,31,.92);color:#f3eefc;border:2px solid #ff4fa3;box-shadow:4px 4px 0 #000;padding:8px 12px;font:13px/1.45 ui-monospace,monospace;white-space:pre-line;transition:opacity .4s}" +
        ".arcade-toast.out{opacity:0}";

    var bar = el("div", "arcade-bar");
    stopKeys(bar);

    function renderBar() {
        var icon = muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊";
        bar.innerHTML =
            '<a href="/" target="_self" title="Zur Arcade" style="color:inherit;text-decoration:none">🕹️</a>' +
            '<button data-mute title="Ton an/aus">' + icon + "</button>" +
            '<input type="range" min="0" max="1" step="0.05" value="' + volume + '" title="Lautstärke">' +
            (SCORED ? '<button data-board title="Bestenliste">🏆</button>' : "") +
            (SCORED && playerName ? '<span class="who" title="Du spielst als">' + escapeHtml(playerName) + "</span>" : "");
        bar.querySelector("[data-mute]").onclick = function () {
            setVolume(volume, !muted);
        };
        bar.querySelector("input").oninput = function (e) {
            setVolume(Number(e.target.value), false);
        };
        var board = bar.querySelector("[data-board]");
        if (board) {
            board.onclick = function () {
                api("GET", "?game=" + encodeURIComponent(GAME)).then(showBoard);
            };
        }
    }

    var toastBox = null;
    function showToast(text) {
        if (!toastBox) {
            toastBox = el("div", "arcade-toasts");
            document.body.appendChild(toastBox);
        }
        var t = el("div", "arcade-toast");
        t.textContent = text;
        toastBox.appendChild(t);
        setTimeout(function () {
            t.classList.add("out");
            setTimeout(function () { t.remove(); }, 400);
        }, 7000);
    }

    function showBoard(result) {
        var load = result ? Promise.resolve(result) : api("GET", "?game=" + encodeURIComponent(GAME));
        return load.then(function (d) {
            var panel = el("div", "arcade-panel");
            var rows = (d.scores || [])
                .map(function (s) {
                    var me = result && s.name === result.name ? ' class="me"' : "";
                    return "<li" + me + ">" + escapeHtml(s.name) + "<span>" + formatScore(s.score) + "</span></li>";
                })
                .join("");
            var info = result ? "<p>Dein Ergebnis: " + formatScore(result.score) + " – Platz " + result.rank + "</p>" : "";
            panel.innerHTML =
                "<div><h3>🏆 Bestenliste</h3><ol>" + (rows || "<li>Noch keine Einträge</li>") + "</ol>" + info +
                '<button type="button">Weiter</button></div>';
            panel.querySelector("button").onclick = function () {
                panel.remove();
            };
            panel.addEventListener("click", function (e) {
                if (e.target === panel) panel.remove();
            });
            stopKeys(panel);
            document.body.appendChild(panel);
        });
    }

    function mount() {
        var style = el("style");
        style.textContent = css;
        document.head.appendChild(style);
        renderBar();
        document.body.appendChild(bar);
        if (SCORED) resolveName();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
    else mount();
})();
