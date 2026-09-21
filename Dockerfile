FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY scripts ./scripts
COPY public ./public

# Player saves live here — mount a volume to keep them across deploys.
ENV DATA_DIR=/data
VOLUME /data

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
