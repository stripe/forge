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

COPY --chown=root:root entrypoint.sh /usr/local/bin/forge-entrypoint
RUN chmod 0755 /usr/local/bin/forge-entrypoint

ENV HOME=/home/forge
WORKDIR /workspace
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/forge-entrypoint"]
