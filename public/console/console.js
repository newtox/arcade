// "Bring your own ROM" console: the player picks a ROM from their own disk,
// it is kept in this browser (IndexedDB) and started with EmulatorJS.
// Nothing is uploaded to the server.
(function () {
    "use strict";

    var root = document.getElementById("console");
    var cfg = root.dataset;
    var SYSTEM = cfg.system;
    var EXTENSIONS = cfg.extensions.split(",");
    var picker = root.querySelector(".picker");
    var list = root.querySelector(".library");
    var input = root.querySelector("input[type=file]");
    var remember = root.querySelector("input[name=remember]");
    var drop = root.querySelector(".drop");
    var status = root.querySelector(".status");

    function setStatus(text, isError) {
        status.textContent = text || "";
        status.className = "status" + (isError ? " error" : "");
    }

    // ---------- IndexedDB ----------

    function db() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open("arcade-roms", 1);
            req.onupgradeneeded = function () {
                var store = req.result.createObjectStore("roms", { keyPath: "id", autoIncrement: true });
                store.createIndex("system", "system");
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function tx(mode, fn) {
        return db().then(function (d) {
            return new Promise(function (resolve, reject) {
                var t = d.transaction("roms", mode);
                var result = fn(t.objectStore("roms"));
                t.oncomplete = function () { resolve(result && "result" in result ? result.result : result); };
                t.onerror = function () { reject(t.error); };
                t.onabort = function () { reject(t.error); };
            });
        });
    }

    function listRoms() {
        return db().then(function (d) {
            return new Promise(function (resolve) {
                var out = [];
                var req = d.transaction("roms").objectStore("roms").index("system").openCursor(IDBKeyRange.only(SYSTEM));
                req.onsuccess = function () {
                    var cur = req.result;
                    if (!cur) return resolve(out);
                    var v = cur.value;
                    out.push({ id: v.id, name: v.name, size: v.size, lastPlayed: v.lastPlayed });
                    cur.continue();
                };
                req.onerror = function () { resolve(out); };
            });
        }).catch(function () { return []; });
    }

    // ---------- UI ----------

    function formatSize(bytes) {
        if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
        return Math.max(1, Math.round(bytes / 1024)) + " KB";
    }

    function renderList() {
        listRoms().then(function (roms) {
            roms.sort(function (a, b) { return (b.lastPlayed || 0) - (a.lastPlayed || 0); });
            list.innerHTML = "";
            if (!roms.length) {
                list.innerHTML = '<li class="empty">Noch keine Spiele gespeichert.</li>';
                return;
            }
            roms.forEach(function (rom) {
                var li = document.createElement("li");
                var play = document.createElement("button");
                play.className = "play";
                play.textContent = "▶ " + rom.name;
                play.title = "Spielen";
                play.onclick = function () { startStored(rom.id); };
                var meta = document.createElement("small");
                meta.textContent = formatSize(rom.size);
                var del = document.createElement("button");
                del.className = "delete";
                del.textContent = "✕";
                del.title = "Aus dem Browser löschen";
                del.onclick = function () {
                    if (!confirm('"' + rom.name + '" aus diesem Browser löschen? Spielstände bleiben erhalten.')) return;
                    tx("readwrite", function (s) { return s.delete(rom.id); }).then(renderList);
                };
                li.appendChild(play);
                li.appendChild(meta);
                li.appendChild(del);
                list.appendChild(li);
            });
        });
    }

    function acceptable(file) {
        var name = file.name.toLowerCase();
        return EXTENSIONS.some(function (ext) { return name.endsWith(ext); });
    }

    function handleFile(file) {
        if (!file) return;
        if (!acceptable(file)) {
            setStatus("Diese Datei passt nicht zu diesem Automaten. Erlaubt: " + EXTENSIONS.join(", "), true);
            return;
        }
        if (!remember.checked) return launch(file);
        setStatus("Speichere im Browser …");
        tx("readwrite", function (s) {
            return s.add({ system: SYSTEM, name: file.name, size: file.size, blob: file, added: Date.now(), lastPlayed: Date.now() });
        }).then(function () {
            launch(file);
        }, function () {
            setStatus("Konnte nicht im Browser speichern (zu wenig Speicher?) – starte trotzdem.", true);
            launch(file);
        });
    }

    function startStored(id) {
        tx("readwrite", function (s) {
            var req = s.get(id);
            req.onsuccess = function () {
                if (req.result) {
                    req.result.lastPlayed = Date.now();
                    s.put(req.result);
                }
            };
            return req;
        }).then(function (rom) {
            if (!rom) return setStatus("Spiel nicht gefunden.", true);
            launch(new File([rom.blob], rom.name));
        });
    }

    var launched = false;
    function launch(file) {
        if (launched) return;
        launched = true;
        picker.remove();
        root.classList.add("running");
        window.EJS_player = "#game";
        window.EJS_core = cfg.core;
        window.EJS_gameUrl = file;
        window.EJS_gameName = file.name.replace(/\.[^.]+$/, "");
        window.EJS_pathtodata = cfg.ejs;
        window.EJS_language = "de-GER";
        window.EJS_volume = 1;
        window.EJS_color = "#ff4fa3";
        window.EJS_startOnLoaded = true;
        if (cfg.bios) window.EJS_biosUrl = cfg.bios;
        var s = document.createElement("script");
        s.src = cfg.ejs + "loader.js";
        document.body.appendChild(s);
    }

    input.addEventListener("change", function () { handleFile(input.files[0]); });
    ["dragenter", "dragover"].forEach(function (type) {
        drop.addEventListener(type, function (e) {
            e.preventDefault();
            drop.classList.add("over");
        });
    });
    ["dragleave", "drop"].forEach(function (type) {
        drop.addEventListener(type, function () { drop.classList.remove("over"); });
    });
    drop.addEventListener("drop", function (e) {
        e.preventDefault();
        handleFile(e.dataTransfer.files[0]);
    });

    if (!window.indexedDB) {
        remember.checked = false;
        remember.disabled = true;
    }
    renderList();
})();
