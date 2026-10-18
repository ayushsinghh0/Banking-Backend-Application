# One Dockerfile for every service:  docker build --build-arg SERVICE=auth-service .
# The "build" stage keeps dev tooling (Prisma CLI) and doubles as the migration runner image.

FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/common/package.json packages/common/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/auth-service/package.json services/auth-service/
COPY services/customer-service/package.json services/customer-service/
COPY services/account-service/package.json services/account-service/
COPY services/transaction-service/package.json services/transaction-service/
COPY services/notification-service/package.json services/notification-service/
COPY services/fraud-service/package.json services/fraud-service/
RUN npm ci
COPY packages ./packages
COPY services ./services
RUN npm run build

FROM build AS prune
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prune --chown=node:node /app/node_modules ./node_modules
COPY --from=prune --chown=node:node /app/packages ./packages
COPY --from=prune --chown=node:node /app/services ./services
ARG SERVICE
ENV SERVICE=${SERVICE}
WORKDIR /app/services/${SERVICE}
USER node
CMD ["node", "dist/app.js"]
