import type { Logger } from 'pino';

/**
 * Loose pipeline shape compatible with @huggingface/transformers'
 * `TextClassificationPipeline` and `TokenClassificationPipeline`. We type
 * narrowly here to keep the rest of the code free of that dep.
 */
/**
 * Env vars that override the default model IDs with a local on-disk path.
 * Set by the production Dockerfile so the daemon never needs HuggingFace
 * reachable at runtime — the model files are baked into the image.
 */
const ENV_INJECTION_MODEL_PATH = 'AUTOPOD_INJECTION_MODEL_PATH';
const ENV_PII_MODEL_PATH = 'AUTOPOD_PII_MODEL_PATH';

export type TextClassificationOutput = Array<{ label: string; score: number }>;
export type TextClassifier = (text: string) => Promise<TextClassificationOutput>;

export type TokenClassificationItem = {
  entity: string;
  score: number;
  index: number;
  word: string;
  start?: number;
  end?: number;
};
export type TokenClassificationOutput = TokenClassificationItem[];
export type TokenClassifier = (text: string) => Promise<TokenClassificationOutput>;

/**
 * Synchronous load state of a single classifier. `unloaded` means no caller has
 * requested it yet; `loading` means a request is in flight; `loaded`/`failed`
 * are terminal.
 */
export type ModelStatus = 'unloaded' | 'loading' | 'loaded' | 'failed';

/**
 * Lazy ONNX model loader. The real implementation defers the
 * `@huggingface/transformers` import until first use so the daemon can start
 * without network access; tests inject a fake.
 */
export interface ModelManager {
  /** Returns null if the model failed to load — caller should treat the detector as unavailable. */
  getInjectionClassifier(): Promise<TextClassifier | null>;
  /** Returns null if the model failed to load — caller should treat the detector as unavailable. */
  getPiiClassifier(): Promise<TokenClassifier | null>;
  /** Snapshot of current load state for both classifiers. Does not trigger a load. */
  getStatus(): { injection: ModelStatus; pii: ModelStatus };
}

export interface ModelManagerConfig {
  injectionModel?: string;
  piiModel?: string;
  /**
   * Optional cache directory for downloaded ONNX weights. Defaults to
   * @huggingface/transformers' built-in cache (`~/.cache/huggingface/`).
   */
  cacheDir?: string;
  logger: Logger;
}

const DEFAULT_INJECTION_MODEL = 'protectai/deberta-v3-base-prompt-injection-v2';
const DEFAULT_PII_MODEL = 'iiiorg/piiranha-v1-detect-personal-information';

/**
 * Production model manager. Loads ONNX models via `@huggingface/transformers`
 * the first time each detector asks for one. Subsequent calls return the
 * cached pipeline. Load failures are sticky: once a model fails to load,
 * we stop retrying for the daemon's lifetime.
 */
export function createModelManager(config: ModelManagerConfig): ModelManager {
  let injectionLoading: Promise<TextClassifier | null> | null = null;
  let piiLoading: Promise<TokenClassifier | null> | null = null;
  let injectionStatus: ModelStatus = 'unloaded';
  let piiStatus: ModelStatus = 'unloaded';

  async function loadInjection(): Promise<TextClassifier | null> {
    injectionStatus = 'loading';
    try {
      const { pipeline } = await import('@huggingface/transformers');
      const localPath = process.env[ENV_INJECTION_MODEL_PATH];
      const model = localPath ?? config.injectionModel ?? DEFAULT_INJECTION_MODEL;
      config.logger.info(
        { model, source: localPath ? 'local' : 'hf' },
        'Loading prompt-injection classifier (ONNX)',
      );
      const pipe = await pipeline('text-classification', model);
      injectionStatus = 'loaded';
      return async (text: string) => {
        const out = await pipe(text);
        return Array.isArray(out) ? (out as TextClassificationOutput) : [out as never];
      };
    } catch (err) {
      injectionStatus = 'failed';
      config.logger.warn(
        { err },
        'Failed to load prompt-injection classifier — detector will be inactive',
      );
      return null;
    }
  }

  async function loadPii(): Promise<TokenClassifier | null> {
    piiStatus = 'loading';
    try {
      const { pipeline } = await import('@huggingface/transformers');
      const localPath = process.env[ENV_PII_MODEL_PATH];
      const model = localPath ?? config.piiModel ?? DEFAULT_PII_MODEL;
      config.logger.info(
        { model, source: localPath ? 'local' : 'hf' },
        'Loading PII NER classifier (ONNX)',
      );
      const pipe = await pipeline('token-classification', model);
      piiStatus = 'loaded';
      return async (text: string) => {
        const out = await pipe(text);
        return Array.isArray(out) ? (out as TokenClassificationOutput) : [out as never];
      };
    } catch (err) {
      piiStatus = 'failed';
      config.logger.warn({ err }, 'Failed to load PII NER classifier — detector will be inactive');
      return null;
    }
  }

  return {
    getInjectionClassifier(): Promise<TextClassifier | null> {
      if (!injectionLoading) injectionLoading = loadInjection();
      return injectionLoading;
    },
    getPiiClassifier(): Promise<TokenClassifier | null> {
      if (!piiLoading) piiLoading = loadPii();
      return piiLoading;
    },
    getStatus() {
      return { injection: injectionStatus, pii: piiStatus };
    },
  };
}
