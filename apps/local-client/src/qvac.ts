import {
  cancel,
  completion,
  loadModel,
  QWEN3_5_4B_MULTIMODAL_Q4_K_M,
  unloadModel,
} from '@qvac/sdk';
import { createQvacProvider } from '@kaleidorg/mind/qvac';
import type { AiIntent } from '@rgb-exchange/contracts';
import { IntentValidationError } from './intent-amounts.ts';
import { interpretWithMind, type IntentAsset } from './mind-intent.ts';

export type QvacAsset = IntentAsset;
export type QvacHealth = {
  available: boolean;
  state?: 'loading' | 'ready' | 'unavailable';
  model: string;
  reason?: string;
};
export type QvacResult = {
  output: AiIntent;
  diagnostics: {
    provider: 'qvac';
    engine: 'kaleidomind';
    model: string;
    durationMs: number;
    turns: number;
    stopReason?: string;
  };
};
const MODEL = QWEN3_5_4B_MULTIMODAL_Q4_K_M;
const MODEL_NAME = MODEL.name;
const LOAD_TIMEOUT_MS = 180_000;
const INFERENCE_TIMEOUT_MS = 90_000;
const MAX_GOAL_LENGTH = 1_200;

export class QvacUnavailableError extends Error {
  constructor(message = 'The local QVAC model is unavailable') {
    super(message);
    this.name = 'QvacUnavailableError';
  }
}
export class QvacInvalidOutputError extends Error {
  constructor() {
    super('The local assistant could not interpret the goal. Clarify the terms or try again.');
    this.name = 'QvacInvalidOutputError';
  }
}

/** Model, prompts and the KaleidoMind tools stay inside the local client. */
export class QvacInterpreter {
  private modelId?: string;
  private loading?: Promise<string>;

  async health(): Promise<QvacHealth> {
    if (!supportsNode())
      return {
        available: false,
        state: 'unavailable',
        model: MODEL_NAME,
        reason: 'Node.js 22.17 or newer is required',
      };
    try {
      await this.ensureModel();
      return { available: true, state: 'ready', model: MODEL_NAME };
    } catch {
      return {
        available: false,
        state: 'unavailable',
        model: MODEL_NAME,
        reason: 'Could not load the local QVAC model. Retry the goal.',
      };
    }
  }

  async interpret(goal: string, assets: QvacAsset[]): Promise<QvacResult> {
    validateInput(goal, assets);
    if (!supportsNode()) throw new QvacUnavailableError('Node.js 22.17 or newer is required');
    const started = Date.now();
    let modelId: string;
    try {
      modelId = await this.ensureModel();
    } catch {
      throw new QvacUnavailableError('The local QVAC model could not load. Retry the goal.');
    }
    const provider = createQvacProvider({
      completion,
      cancel,
      getModelId: () => modelId,
      defaultTemperature: 0,
      defaultMaxTokens: 1536,
      maxThinkingTokens: 512,
      timeoutMs: INFERENCE_TIMEOUT_MS,
    });
    try {
      const result = await interpretWithMind(
        provider,
        goal,
        assets,
        AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
      );
      return {
        output: result.output,
        diagnostics: {
          provider: 'qvac',
          engine: 'kaleidomind',
          model: MODEL_NAME,
          durationMs: Date.now() - started,
          turns: result.turns,
        },
      };
    } catch (error) {
      if (error instanceof IntentValidationError) throw error;
      throw new QvacUnavailableError('Local QVAC inference failed or timed out. Retry the goal.');
    }
  }

  async dispose(): Promise<void> {
    if (this.loading) await this.loading.catch(() => undefined);
    if (this.modelId) {
      const modelId = this.modelId;
      this.modelId = undefined;
      await unloadModel({ modelId, clearStorage: false });
    }
  }

  private async ensureModel(): Promise<string> {
    if (this.modelId) return this.modelId;
    if (!this.loading) {
      const cpu = process.env.QVAC_DEVICE === 'cpu';
      const operation = loadModel({
        modelSrc: MODEL,
        modelConfig: {
          ctx_size: 4096,
          tools: true,
          ...(cpu ? { device: 'cpu', gpu_layers: 0 } : {}),
        },
      });
      this.loading = withTimeout(operation, LOAD_TIMEOUT_MS, () =>
        cancel({ requestId: operation.requestId }),
      )
        .then((modelId) => {
          this.modelId = modelId;
          return modelId;
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    return this.loading;
  }
}

function validateInput(goal: string, assets: QvacAsset[]): void {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > MAX_GOAL_LENGTH)
    throw new Error('The goal must contain 1 to 1200 characters');
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 100)
    throw new Error('A list of verified assets is required');
  const keys = new Set<string>();
  for (const asset of assets) {
    if (
      typeof asset.key !== 'string' ||
      !asset.key ||
      asset.key.length > 250 ||
      typeof asset.symbol !== 'string' ||
      asset.symbol.length > 40 ||
      !Number.isInteger(asset.precision) ||
      asset.precision < 0 ||
      asset.precision > 18 ||
      keys.has(asset.key)
    )
      throw new Error('Invalid asset list');
    keys.add(asset.key);
  }
}

function supportsNode(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 17);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  cancelOperation: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void cancelOperation().catch(() => undefined);
      reject(new QvacUnavailableError('QVAC timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
