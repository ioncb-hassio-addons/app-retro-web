ARG BUILD_FROM=ghcr.io/hassio-addons/base:21.0.12

# hadolint ignore=DL3006,DL3018
FROM ${BUILD_FROM} AS assets
WORKDIR /build
RUN apk add --no-cache \
    nodejs=24.22.3-r0 \
    npm=11.12.1-r0 \
    libcrypto3=3.5.9-r1 \
    libssl3=3.5.9-r1 \
    openssl=3.5.9-r1
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --include=dev --omit=optional \
    && node scripts/sync-emulator-assets.mjs

# hadolint ignore=DL3006,DL3018
FROM ${BUILD_FROM}

WORKDIR /opt/retro-web

COPY package.json package-lock.json ./
RUN apk add --no-cache \
    nodejs=24.22.3-r0 \
    npm=11.12.1-r0 \
    libcrypto3=3.5.9-r1 \
    libssl3=3.5.9-r1 \
    openssl=3.5.9-r1 \
    && npm ci --omit=dev --omit=optional --ignore-scripts

COPY app ./app
COPY public ./public
COPY --from=assets /build/public/vendor ./public/vendor
COPY rootfs /

ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_DESCRIPTION
ARG BUILD_NAME
ARG BUILD_REF
ARG BUILD_REPOSITORY
ARG BUILD_VERSION

LABEL \
    io.hass.name="${BUILD_NAME}" \
    io.hass.description="${BUILD_DESCRIPTION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Jhon Coronel <jcoronel@ioncb.com>" \
    org.opencontainers.image.title="${BUILD_NAME}" \
    org.opencontainers.image.description="${BUILD_DESCRIPTION}" \
    org.opencontainers.image.vendor="IonCB Home Assistant Apps" \
    org.opencontainers.image.authors="Jhon Coronel <jcoronel@ioncb.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/ioncb-hassio-addons/app-retro-web" \
    org.opencontainers.image.source="https://github.com/${BUILD_REPOSITORY}" \
    org.opencontainers.image.documentation="https://github.com/${BUILD_REPOSITORY}/blob/main/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}
