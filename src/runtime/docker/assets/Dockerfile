FROM docker.io/library/node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 forge \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/sh forge \
    && mkdir -p /workspace /home/forge \
    && chown -R forge:forge /workspace /home/forge

RUN npm install --global --omit=dev --no-audit --no-fund \
      @anthropic-ai/claude-code@2.1.273 \
      @openai/codex@0.149.0 \
    && test -x /usr/local/bin/claude \
    && /usr/local/bin/claude --version \
    && test -x /usr/local/bin/codex \
    && /usr/local/bin/codex --version

# Browser dependencies are installed only for plans requesting forge/browser.
ARG FORGE_BROWSER_ENABLED=false
COPY --chown=root:root browser /opt/forge-browser
RUN if [ "$FORGE_BROWSER_ENABLED" = true ]; then \
      cd /opt/forge-browser \
      && npm ci --omit=dev --no-audit --no-fund \
      && PLAYWRIGHT_BROWSERS_PATH=/opt/forge-browsers npx --no-install playwright install --with-deps chromium \
      && chmod -R a+rX /opt/forge-browsers \
      && chmod 0755 /opt/forge-browser/service.cjs \
      && ln -s /opt/forge-browser/service.cjs /usr/local/bin/forge-browser \
      && rm -rf /var/lib/apt/lists/*; \
    fi

COPY --chown=root:root entrypoint.sh /usr/local/bin/forge-entrypoint
RUN chmod 0755 /usr/local/bin/forge-entrypoint

# Match the non-root container user to the invoking host UID when Forge builds
# the image. Bind-mounted files then have one owner on native Linux in both the
# host and container views. UID 1000 belongs to the unused base-image `node`
# account, so remove that account before remapping the run user.
ARG FORGE_UID=10001
RUN if getent passwd node >/dev/null; then userdel --remove node; fi \
    && usermod --uid "${FORGE_UID}" forge \
    && chown -R forge:forge /workspace /home/forge

ENV HOME=/home/forge
WORKDIR /workspace
USER forge:forge
ENTRYPOINT ["/usr/local/bin/forge-entrypoint"]
