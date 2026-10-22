FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build:node

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV GROKBOT_STATE_DIR=/data
ENV BRIDGE_HOST=0.0.0.0
ENV BRIDGE_PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown -R node:node /app /data
COPY --from=build /app/dist ./dist
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/node/cli.js", "start"]
