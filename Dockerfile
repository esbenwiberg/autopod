# ─── PII model preparation ─────────────────────────────────
# Convert Piiranha (PyTorch-only on HF) → quantized ONNX once at image build
# time, and stage at the on-disk layout @huggingface/transformers expects
# (<root>/onnx/model_quantized.onnx + tokenizer files at <root>/).
# This stage runs only at image build time; runtime never hits HuggingFace.
# Output is ~280MB after int8 quantization (down from ~1GB at fp32).
FROM python:3.11-slim AS pii-model
RUN pip install --no-cache-dir "optimum[onnxruntime]" transformers
RUN optimum-cli export onnx \
    --model iiiorg/piiranha-v1-detect-personal-information \
    --task token-classification \
    /tmp/raw
RUN python -c "from optimum.onnxruntime import ORTQuantizer; \
from optimum.onnxruntime.configuration import AutoQuantizationConfig; \
q = ORTQuantizer.from_pretrained('/tmp/raw'); \
qc = AutoQuantizationConfig.avx2(is_static=False, per_channel=False); \
q.quantize(save_dir='/tmp/quant', quantization_config=qc)"
RUN mkdir -p /models/piiranha/onnx \
    && cp /tmp/raw/*.json /models/piiranha/ \
    && (cp /tmp/raw/spm.model /models/piiranha/ 2>/dev/null || true) \
    && (cp /tmp/raw/sentencepiece.bpe.model /models/piiranha/ 2>/dev/null || true) \
    && (cp /tmp/raw/tokenizer* /models/piiranha/ 2>/dev/null || true) \
    && cp /tmp/quant/model_quantized.onnx /models/piiranha/onnx/model.onnx

# ─── Build stage ────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace config first (cache layer)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/daemon/package.json packages/daemon/
COPY packages/validator/package.json packages/validator/
COPY packages/escalation-mcp/package.json packages/escalation-mcp/

# Install dependencies
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/daemon/ packages/daemon/
COPY packages/validator/ packages/validator/
COPY packages/escalation-mcp/ packages/escalation-mcp/
COPY tsconfig.base.json ./

# Build all packages
RUN pnpm run build

# ─── Production stage ──────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache tini git docker-cli

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/packages/daemon/dist ./packages/daemon/dist
COPY --from=builder /app/packages/daemon/package.json ./packages/daemon/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/validator/dist ./packages/validator/dist
COPY --from=builder /app/packages/validator/package.json ./packages/validator/
COPY --from=builder /app/packages/escalation-mcp/dist ./packages/escalation-mcp/dist
COPY --from=builder /app/packages/escalation-mcp/package.json ./packages/escalation-mcp/

# Copy workspace config for production install
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./

# Install production dependencies only
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod

# Bake the PII model into the image (see the pii-model stage above).
# Runtime is opted in via AUTOPOD_SECURITY_ML=true; AUTOPOD_PII_MODEL_PATH
# tells model-manager to load from disk instead of HuggingFace.
COPY --from=pii-model /models/piiranha /opt/autopod/models/piiranha
ENV AUTOPOD_PII_MODEL_PATH=/opt/autopod/models/piiranha

# Create non-root user
RUN addgroup -g 1000 autopod && \
    adduser -u 1000 -G autopod -s /bin/sh -D autopod

# Create data directory for SQLite
RUN mkdir -p /data && chown autopod:autopod /data
RUN chown -R autopod:autopod /opt/autopod

USER autopod

EXPOSE 3000

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/daemon/dist/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
