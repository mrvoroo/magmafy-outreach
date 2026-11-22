FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN useradd -m app && mkdir -p /data && chown app /data
USER app
ENV DB_PATH=/data/outreach.sqlite AUTH_STATE_DIR=/data/auth_state BACKUP_DIR=/data/backups
CMD ["node", "dist/main.js"]
