FROM alpine:3.20 AS games
RUN apk add --no-cache git
WORKDIR /games
RUN git clone --depth 1 https://github.com/gabrielecirulli/2048.git 2048 \
 && git clone --depth 1 https://github.com/Hextris/hextris.git hextris \
 && git clone --depth 1 https://github.com/daleharvey/pacman.git pacman \
 && git clone --depth 1 https://github.com/jakesgordon/javascript-tetris.git tetris \
 && rm -rf */.git

FROM node:22-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1 PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY --from=games /games ./games
COPY server.mjs ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
