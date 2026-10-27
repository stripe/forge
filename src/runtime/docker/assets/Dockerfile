FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

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
