FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

RUN npm install --global --omit=dev @openai/codex@0.146.0 \
    && npm cache clean --force \
    && groupadd --gid 10001 codex \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /codex-home codex \
    && mkdir --mode=0700 /codex-home \
    && mkdir --mode=0755 /schemas /workspace \
    && chown codex:codex /codex-home /workspace

COPY --chown=root:root node.schema.json main.schema.json evaluator.schema.json /schemas/
RUN chmod 0444 /schemas/*.schema.json

ENV CODEX_HOME=/codex-home
USER 10001:10001
WORKDIR /workspace
CMD ["codex", "--version"]
