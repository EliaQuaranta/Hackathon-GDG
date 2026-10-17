FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATABASE_PATH=/data/reports.sqlite

WORKDIR /app/community-app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY client ./client
# Il wildcard evita il fallimento se baseline.json non è stato generato.
COPY data/baseline.jso[n] ./data/

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4173
VOLUME ["/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "--experimental-strip-types", "src/server.ts"]
