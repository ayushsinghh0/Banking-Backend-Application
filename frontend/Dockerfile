# BankSphere web app: static build served by an unprivileged nginx that also proxies /api to the gateway.
#   docker build -t banksphere-web ./frontend

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
ENV CI=true
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# The slim variant: no curl and none of the geoip, image-filter, xslt and njs modules. The configuration loads
# no module, and those packages carried most of the image's advisories.
FROM nginxinc/nginx-unprivileged:1.31-alpine-slim@sha256:a8cb0f33d51fa107c96fd2bd3a71aaf564ec131e9d2bdf8700944f0ed8b170d7 AS runtime
# Alpine publishes fixes more often than the base image is rebuilt: upgrade its packages (apk needs root)
USER root
RUN apk upgrade --no-cache
# nginx runs as the unprivileged uid 101; stated here so the guarantee does not depend on the base image
USER 101
# Templates are rendered into conf.d at start-up (mounted as tmpfs when the filesystem is read-only)
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
# The entrypoint only sources executable .envsh files (it sets the CSP for Razorpay Checkout before templating)
COPY --chmod=0755 nginx/15-razorpay-csp.envsh /docker-entrypoint.d/15-razorpay-csp.envsh
COPY --from=build /app/dist /usr/share/nginx/html
ENV API_UPSTREAM=api-gateway:8000 \
    TRUSTED_PROXY_CIDR=127.0.0.1/32 \
    RAZORPAY_CHECKOUT=off \
    NGINX_ENTRYPOINT_QUIET_LOGS=1
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
