FROM node:22-alpine

RUN apk add --no-cache curl

WORKDIR /app
COPY package.json server.mjs ./
COPY src/ ./src/
COPY rules/ ./rules/
COPY www/ ./www/

ENV NODE_ENV=production
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
