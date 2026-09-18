FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The RDS global certificate bundle: db.ts passes it as the pg pool's ssl.ca
# so the Postgres server certificate verifies like the API does.
RUN apk add --no-cache ca-certificates curl \
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      -o /etc/ssl/certs/rds-global-bundle.pem \
 && apk del curl
COPY package.json package-lock.json* ./
COPY vendor ./vendor
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
