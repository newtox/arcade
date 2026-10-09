(function () {
    "use strict";

    var script = document.currentScript;
    var GAME = script && script.dataset.game;
    var WA_URL = script && script.dataset.wa;
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

    // ---------- Volume ----------

    var volume = Number(store.get("volume", "0.3"));
    if (!(volume >= 0 && volume <= 1)) volume = 0.3;
    var muted = store.get("muted", "false") === "true";
    var media = new Set();

    function applyVolume(el) {
        try {
            el.volume = volume;
            el.muted = muted;
        } catch (e) {}
    }

    var originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        media.add(this);
        applyVolume(this);
        return originalPlay.apply(this, arguments);
    };

    function setVolume(v, m) {
        volume = v;
        muted = m;
        store.set("volume", String(v));
        store.set("muted", String(m));
        media.forEach(applyVolume);
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

    function askName() {
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
            ["keydown", "keyup", "keypress"].forEach(function (type) {
                dialog.addEventListener(type, function (e) {
                    e.stopPropagation();
                });
            });
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
            return r.json().then(function (data) {
                if (!r.ok) throw new Error(data.error || "request failed");
                return data;
            });
        });
    }

    window.arcadeGameOver = function (rawScore) {
        var score = Math.floor(Number(rawScore));
        if (!(score >= 0)) return;
        var now = Date.now();
        if (score === lastReport.score && now - lastReport.time < 5000) return;
        lastReport = { score: score, time: now };
        if (score === 0) return;

        resolveName()
            .then(function (name) {
                return name || askName();
            })
            .then(function (name) {
                if (!name) return showBoard(null);
                return api("POST", "", { game: GAME, name: name, score: score }).then(showBoard, function () {
                    showBoard(null);
                });
            });
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

    var style = el("style");
    style.textContent =
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
        ".arcade-dialog div{display:flex;gap:8px;justify-content:flex-end}.arcade-dialog [data-skip]{background:#3d3360;color:#f3eefc}";
    document.head.appendChild(style);

    var bar = el("div", "arcade-bar");

    function renderBar() {
        var icon = muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊";
        bar.innerHTML =
            '<a href="/" target="_self" title="Zur Arcade" style="color:inherit;text-decoration:none">🕹️</a>' +
            '<button data-mute title="Ton an/aus">' + icon + "</button>" +
            '<input type="range" min="0" max="1" step="0.05" value="' + volume + '" title="Lautstärke">' +
            '<button data-board title="Bestenliste">🏆</button>' +
            (playerName ? '<span class="who" title="Du spielst als">' + escapeHtml(playerName) + "</span>" : "");
        bar.querySelector("[data-mute]").onclick = function () {
            setVolume(volume, !muted);
        };
        bar.querySelector("input").oninput = function (e) {
            setVolume(Number(e.target.value), false);
        };
        bar.querySelector("[data-board]").onclick = function () {
            api("GET", "?game=" + encodeURIComponent(GAME)).then(showBoard);
        };
    }

    function showBoard(result) {
        var load = result ? Promise.resolve(result) : api("GET", "?game=" + encodeURIComponent(GAME));
        return load.then(function (data) {
            var panel = el("div", "arcade-panel");
            var rows = (data.scores || [])
                .map(function (s) {
                    var me = result && s.name === result.name ? ' class="me"' : "";
                    return "<li" + me + ">" + escapeHtml(s.name) + "<span>" + Number(s.score).toLocaleString("de-DE") + "</span></li>";
                })
                .join("");
            var info = result
                ? "<p>Deine Punkte: " + Number(result.score).toLocaleString("de-DE") + " – Platz " + result.rank + "</p>"
                : "";
            panel.innerHTML =
                "<div><h3>🏆 Bestenliste</h3><ol>" + (rows || "<li>Noch keine Punkte</li>") + "</ol>" + info +
                '<button type="button">Weiter</button></div>';
            panel.querySelector("button").onclick = function () {
                panel.remove();
            };
            panel.addEventListener("click", function (e) {
                if (e.target === panel) panel.remove();
            });
            document.body.appendChild(panel);
        });
    }

    // ---------- Game hooks ----------

    function hook() {
        if (GAME === "tetris" && typeof window.lose === "function") {
            var lose = window.lose;
            window.lose = function () {
                var score = window.score;
                var result = lose.apply(this, arguments);
                window.arcadeGameOver(score);
                return result;
            };
        }

        if (GAME === "hextris" && typeof window.gameOverDisplay === "function") {
            var gameOverDisplay = window.gameOverDisplay;
            window.gameOverDisplay = function () {
                var result = gameOverDisplay.apply(this, arguments);
                window.arcadeGameOver(window.score);
                return result;
            };
        }

        if (GAME === "2048" && window.HTMLActuator) {
            var actuate = window.HTMLActuator.prototype.actuate;
            var reported = false;
            window.HTMLActuator.prototype.actuate = function (grid, metadata) {
                var result = actuate.apply(this, arguments);
                if (metadata && metadata.over && !reported) {
                    reported = true;
                    window.arcadeGameOver(metadata.score);
                } else if (metadata && !metadata.over) {
                    reported = false;
                }
                return result;
            };
        }
    }

    hook();
    renderBar();
    function mount() {
        document.body.appendChild(bar);
        resolveName();
    }
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
})();
