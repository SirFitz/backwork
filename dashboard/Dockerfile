FROM node:20-slim AS build
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NPM_CONFIG_MAXSOCKETS=4
COPY package.json package-lock.json ./
# npm ci is deterministic; retry with a clean cache to survive the cacache
# EEXIST/rename race that shows up on contended disks.
RUN npm ci || (npm cache clean --force && npm ci)
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NPM_CONFIG_MAXSOCKETS=4
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || (npm cache clean --force && npm ci --omit=dev)
COPY --from=build /app/build ./build
COPY instrument.cjs ./
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=25s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# preload OpenTelemetry, then run remix-serve in the same process
CMD ["node", "--require", "./instrument.cjs", "./node_modules/@remix-run/serve/dist/cli.js", "./build/server/index.js"]
