FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bridge.mjs auth-state.mjs server.mjs ui.mjs local-monitor.mjs ./
COPY monitor/ ./monitor/
COPY www/ ./www/

ENV NODE_ENV=production
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
