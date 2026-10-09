// Starts Pac-Man full size: the canvas is drawn at 4x and scaled to the window by CSS.
(function () {
    "use strict";
    var root = document.getElementById("pacman");
    var start = root.querySelector(".pacman-start");
    var button = start.querySelector("button");
    var ready = false;

    function begin() {
        if (!ready) return;
        start.hidden = true;
        var canvas = root.querySelector("canvas");
        if (canvas) canvas.focus();
        PACMAN.newGame();
    }

    function boot() {
        PACMAN.init(root.querySelector(".board"), root.dataset.root, function () {
            ready = true;
            button.disabled = false;
            start.classList.add("ready");
        });
        var canvas = root.querySelector("canvas");
        canvas.tabIndex = 0;
    }

    start.addEventListener("click", begin);
    document.addEventListener("keydown", function (e) {
        if (!start.hidden && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            e.stopImmediatePropagation();
            begin();
        }
        if (e.key === "f" || e.key === "F") {
            try {
                if (document.fullscreenElement) document.exitFullscreen();
                else document.documentElement.requestFullscreen();
            } catch (err) {}
        }
    }, true);

    // the canvas texts use the game's font, so wait for it before the first frame
    var font = document.fonts && document.fonts.load ? document.fonts.load('14px "BDCartoonShoutRegular"') : Promise.resolve();
    font.then(boot, boot);
})();
