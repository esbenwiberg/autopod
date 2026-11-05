# Trusted offline renderer, intentionally separate from worker/reviewer software and credentials.
FROM mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
WORKDIR /opt/autopod-reference-renderer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && test -x /usr/bin/timeout
COPY render.cjs ./
USER pwuser
ENV HOME=/tmp/reference-home
CMD ["/usr/bin/timeout", "--signal=KILL", "25s", "node", "/opt/autopod-reference-renderer/render.cjs"]
