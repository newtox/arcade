FROM alpine:3.20 AS games
RUN apk add --no-cache git curl
WORKDIR /games
RUN git clone --depth 1 https://github.com/KilledByAPixel/SpaceHuggers.git spacehuggers \
 && git clone --depth 1 https://github.com/jackrugile/radius-raid-js13k.git radiusraid \
 && git clone --depth 1 https://github.com/BKcore/HexGL.git hexgl \
 && rm -rf */.git hexgl/package.zip
WORKDIR /roms
RUN curl -fsSLO https://github.com/NovaSquirrel/DABG/releases/download/v2/dabg.nes \
 && curl -fsSLO https://github.com/pinobatch/rhde-nes/releases/download/v0.07/rhde.nes \
 && curl -fsSLO https://github.com/pinobatch/thwaite-nes/releases/download/v0.04/thwaite.nes \
 && curl -fsSLO https://github.com/NovaSquirrel/NovaTheSquirrel/releases/download/v1.0.6a/nova.nes \
 && curl -fsSLO https://github.com/pinobatch/croom-nes/releases/download/v0.02a/croom.nes \
 && curl -fsSLO https://github.com/pinobatch/libbet/releases/download/v0.08/libbet.gb \
 && printf '%s\n' \
    "eca79b9d0b546e96c1bc73099e239539fb9c7773ff10a431bb3a9cd6763208ca  dabg.nes" \
    "b2c4748a5b3651e393572046daf126213653b58b55472cdfdf4b863834dd0241  rhde.nes" \
    "a2df24d9c9f72e56c2fdc4c703becc47a5700ad0158da8208247635ebeb3779c  thwaite.nes" \
    "e4780e90b9d1587489bfb797d2ca395be21371ea9262fa9f87f99324ec6960ab  nova.nes" \
    "2ce17df1ad66a8a0533c0a8739f5b5ebe275c264924bbe350c42c5ac0394f20e  croom.nes" \
    "3607412031c8287cf878299ce96e581e85b852dde703806343b95576fa3ff1a9  libbet.gb" \
    | sha256sum -c -

FROM node:22-alpine AS emulator
WORKDIR /build
RUN npm pack --silent @emulatorjs/emulatorjs@4.2.3 @emulatorjs/core-fceumm@4.2.3 @emulatorjs/core-gambatte@4.2.3 \
 && mkdir -p ejs core && tar -xzf emulatorjs-emulatorjs-4.2.3.tgz -C ejs \
 && for c in fceumm gambatte; do mkdir -p core/$c && tar -xzf emulatorjs-core-$c-4.2.3.tgz -C core/$c; done \
 && mkdir -p out/cores/reports && cp -r ejs/package/data/* out/ \
 && for c in fceumm gambatte; do cp core/$c/package/*.data out/cores/ && cp core/$c/package/reports/*.json out/cores/reports/; done

FROM node:22-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1 PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY --from=games /games ./games
COPY --from=games /roms ./roms
COPY --from=emulator /build/out ./emulatorjs
COPY server.mjs games.mjs ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
