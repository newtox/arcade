# --- Doom engine: doomgeneric + Chocolate Doom OPL music, compiled to WebAssembly with zig ---
FROM public.ecr.aws/docker/library/python:3.12-alpine AS doom
RUN apk add --no-cache git patch && pip install --no-cache-dir ziglang==0.13.0
WORKDIR /src
RUN git init -q doomgeneric \
 && git -C doomgeneric fetch -q --depth 1 https://github.com/ozkl/doomgeneric.git dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284 \
 && git -C doomgeneric checkout -q FETCH_HEAD \
 && git init -q doom-wasm \
 && git -C doom-wasm fetch -q --depth 1 https://github.com/cloudflare/doom-wasm.git 65e0d3ae2ffa604155eebd96ed40da6567bd08f4 \
 && git -C doom-wasm checkout -q FETCH_HEAD
COPY doom ./doom
RUN mkdir -p /out && ZIG="python3 -m ziglang" sh doom/build.sh doomgeneric doom-wasm /out/doom.wasm

# --- Game data (freely distributable IWADs), WASI shim and EmulatorJS with cores ---
FROM public.ecr.aws/docker/library/node:22-alpine AS assets
RUN apk add --no-cache curl unzip
WORKDIR /build
RUN npm pack --silent @nicejsisverycool/tizendoom@0.1.6 @bjorn3/browser_wasi_shim@0.4.2 >/dev/null \
 && mkdir -p wads wasi \
 && tar -xzf nicejsisverycool-tizendoom-0.1.6.tgz -O package/doom1.wad > wads/doom1.wad \
 && curl -fsSLo freedoom.zip https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip \
 && unzip -p freedoom.zip freedoom-0.13.0/freedoom1.wad > wads/freedoom1.wad \
 && unzip -p freedoom.zip freedoom-0.13.0/COPYING.txt > wads/FREEDOOM-COPYING.txt \
 && printf '%s\n' \
    "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771  wads/doom1.wad" \
    "7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d  wads/freedoom1.wad" \
    | sha256sum -c - \
 && tar -xzf bjorn3-browser_wasi_shim-0.4.2.tgz \
 && cp package/dist/*.js package/LICENSE* wasi/ && rm -rf package
ARG EJS_VERSION=4.2.3
ARG EJS_CORES="fceumm gambatte snes9x mupen64plus_next mgba genesis_plus_gx pcsx_rearmed"
RUN npm pack --silent @emulatorjs/emulatorjs@$EJS_VERSION >/dev/null \
 && mkdir -p ejs out/cores/reports && tar -xzf emulatorjs-emulatorjs-$EJS_VERSION.tgz -C ejs \
 && cp -r ejs/package/data/* out/ \
 && for c in $EJS_CORES; do \
      npm pack --silent @emulatorjs/core-$c@$EJS_VERSION >/dev/null \
      && mkdir -p core/$c && tar -xzf emulatorjs-core-$c-$EJS_VERSION.tgz -C core/$c \
      && cp core/$c/package/$c-wasm.data core/$c/package/$c-legacy-wasm.data out/cores/ \
      && cp core/$c/package/reports/*.json out/cores/reports/ || exit 1; \
    done

FROM public.ecr.aws/docker/library/node:22-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1 PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY server.mjs games.mjs ./
COPY public ./public
COPY --from=doom /out/doom.wasm ./public/doom/doom.wasm
COPY --from=assets /build/wasi ./public/vendor/wasi
COPY --from=assets /build/wads ./wads
COPY --from=assets /build/out ./emulatorjs
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
