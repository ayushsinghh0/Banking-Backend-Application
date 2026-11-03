# One Dockerfile for every service:  docker build --build-arg SERVICE=auth-service .
# The "migrate" target keeps the dev tooling (Prisma CLI) and is the migration job image.
# No shipped stage carries npm, npx, yarn or corepack: nothing needs a package manager at run time, and the
# packages bundled inside npm (undici, brace-expansion, ...) are a recurring source of advisories.

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
# Alpine publishes fixes more often than the base image is rebuilt: upgrade its packages at build time
RUN apk upgrade --no-cache && apk add --no-cache openssl
WORKDIR /app
ENV CI=true
COPY package.json package-lock.json tsconfig.json ./
COPY packages/common/package.json packages/common/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/auth-service/package.json services/auth-service/
COPY services/customer-service/package.json services/customer-service/
COPY services/account-service/package.json services/account-service/
COPY services/transaction-service/package.json services/transaction-service/
COPY services/notification-service/package.json services/notification-service/
COPY services/fraud-service/package.json services/fraud-service/
COPY services/payment-service/package.json services/payment-service/
COPY services/assistant-service/package.json services/assistant-service/
COPY services/realtime-service/package.json services/realtime-service/
COPY services/razorpay-simulator/package.json services/razorpay-simulator/
RUN npm ci --no-audit --no-fund
COPY packages ./packages
COPY services ./services
RUN npm run build

FROM build AS prune
RUN npm prune --omit=dev --no-audit --no-fund

# Migration job: the build stage without the package manager (the job runs node_modules/.bin/prisma directly)
FROM build AS migrate
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn*

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
RUN apk upgrade --no-cache && apk add --no-cache openssl \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prune --chown=root:root /app/node_modules ./node_modules
COPY --from=prune --chown=root:root /app/packages ./packages
COPY --from=prune --chown=root:root /app/services ./services
ARG SERVICE
ENV SERVICE=${SERVICE}
WORKDIR /app/services/${SERVICE}
# Code is owned by root and read-only to the runtime user
USER node
CMD ["node", "dist/app.js"]
