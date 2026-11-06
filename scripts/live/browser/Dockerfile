FROM docker.io/library/node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f

# An opt-in development image, separate from the packaged Forge runtime.
COPY package.json package-lock.json /opt/browser/
RUN npm ci --prefix /opt/browser --omit=dev --no-audit --no-fund \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/browsers \
      node /opt/browser/node_modules/playwright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && groupadd --gid 10001 forge \
    && useradd --uid 10001 --gid 10001 --create-home forge

COPY server.mjs probe.mjs /opt/browser/
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
ENV HOME=/home/forge
ENV PATH=/opt/browser/node_modules/.bin:$PATH
USER forge:forge
ENTRYPOINT ["node", "/opt/browser/server.mjs"]
WORKDIR /evidence
