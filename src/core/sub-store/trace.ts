export interface ProcessorScope { kind: 'sub' | 'collection' | 'file'; name: string }
export interface ProcessorTraceStep {
  index: number;
  type: string;
  name?: string;
  status: 'success' | 'skipped' | 'failed' | 'not-run';
  durationMs?: number;
  inputCount?: number;
  outputCount?: number;
  skipReason?: 'disabled' | 'context' | 'response-transformer';
}
export interface ProcessorTrace {
  version: 1;
  chains: { scope: ProcessorScope; steps: ProcessorTraceStep[] }[];
  truncated: boolean;
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function readProcessorScope(value: unknown): ProcessorScope | undefined {
  const scope = record(value);
  if (!scope || !['sub', 'collection', 'file'].includes(String(scope.kind)) || typeof scope.name !== 'string') return;
  return { kind: scope.kind as ProcessorScope['kind'], name: scope.name };
}
/** 诊断是可选数据：拒绝损坏或超预算轨迹，不影响原有预览与错误信息。 */
export function readProcessorTrace(value: unknown): ProcessorTrace | undefined {
  const trace = record(value);
  if (!trace || trace.version !== 1 || typeof trace.truncated !== 'boolean' || !Array.isArray(trace.chains) || trace.chains.length > 200) return;
  const chains: ProcessorTrace['chains'] = [];
  let total = 0;
  for (const raw of trace.chains) {
    const chain = record(raw); const scope = readProcessorScope(chain?.scope);
    if (!chain || !scope || !Array.isArray(chain.steps) || (total += chain.steps.length) > 200) return;
    const steps: ProcessorTraceStep[] = []; let previous = -1;
    for (const rawStep of chain.steps) {
      const step = record(rawStep);
      if (!step || !count(step.index) || step.index <= previous || typeof step.type !== 'string' || !step.type ||
          !['success', 'skipped', 'failed', 'not-run'].includes(String(step.status)) || (step.name !== undefined && typeof step.name !== 'string')) return;
      previous = step.index;
      const executed = step.status === 'success' || step.status === 'failed';
      if (executed ? typeof step.durationMs !== 'number' || !Number.isFinite(step.durationMs) || step.durationMs < 0 : step.durationMs !== undefined) return;
      if ([step.inputCount, step.outputCount].some(value => value !== undefined && !count(value))) return;
      if (step.status === 'failed' && step.outputCount !== undefined || step.status === 'not-run' && (step.inputCount !== undefined || step.outputCount !== undefined)) return;
      if (step.status === 'skipped' ? !['disabled', 'context', 'response-transformer'].includes(String(step.skipReason)) : step.skipReason !== undefined) return;
      steps.push({ index: step.index, type: step.type, status: step.status as ProcessorTraceStep['status'],
        ...(step.name !== undefined ? { name: step.name as string } : {}),
        ...(step.durationMs !== undefined ? { durationMs: step.durationMs as number } : {}),
        ...(step.inputCount !== undefined ? { inputCount: step.inputCount as number } : {}),
        ...(step.outputCount !== undefined ? { outputCount: step.outputCount as number } : {}),
        ...(step.skipReason !== undefined ? { skipReason: step.skipReason as ProcessorTraceStep['skipReason'] } : {}),
      });
    }
    chains.push({ scope, steps });
  }
  const result: ProcessorTrace = { version: 1, chains, truncated: trace.truncated };
  return JSON.stringify(result).length <= 8000 ? result : undefined;
}
