# Synthetic lifecycle fixture, NEVER a production runtime image or model client.
# Build deliberately from a caller-verified CACHED amd64 Node24+Git base, no network.
ARG BASE_IMAGE=node:24-bookworm
FROM ${BASE_IMAGE}
USER root
RUN old="$(getent passwd 1000 | cut -d: -f1)" \
 && test -n "$old" \
 && if [ "$old" != autopod ]; then usermod -l autopod -d /home/autopod "$old"; fi \
 && node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' \
 && git --version \
 && mkdir -p /home/autopod/.local/bin /workspace /autopod/recovery \
 && chown -R 1000:1000 /home/autopod /workspace /autopod
COPY fixture-claude /usr/local/bin/claude
RUN chmod 0555 /usr/local/bin/claude
LABEL autopod.fixture="recovery-fork-deterministic-runtime" \
      autopod.fixture.scope="synthetic-only-no-model-client"
ENV HOME=/home/autopod
USER autopod
WORKDIR /workspace
ENTRYPOINT []
CMD ["sleep", "600"]
