FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bridge.mjs server.mjs ./

ENV NODE_ENV=production
CMD ["node", "server.mjs"]
