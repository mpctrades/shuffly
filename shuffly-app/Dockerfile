# Node 22 LTS — Node 20 stopped receiving security fixes in April 2026.
FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

# Node itself, not `npm run`: npm doesn't forward SIGTERM, so a deploy used to
# kill the app outright after Docker's timeout, mid-reorder. `exec` makes node
# the process that receives the signal; app/lib/background.server.ts then lets
# in-flight work finish. Migrations still run first, as docker-start did.
CMD ["sh", "-c", "npm run setup && exec node node_modules/@react-router/serve/bin.js ./build/server/index.js"]
