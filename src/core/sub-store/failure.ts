import { readProcessorTrace, type ProcessorTrace } from './trace';

export interface ProcessorFailure {
  index: number;
  type: string;
  name?: string;
  scope: { kind: 'sub' | 'collection' | 'file'; name: string };
}
export interface SubStoreFailure { message: string; processor?: ProcessorFailure; trace?: ProcessorTrace }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function processorFailure(value: unknown): ProcessorFailure | undefined {
  const item = record(value); const scope = record(item.scope);
  if (typeof item.index !== 'number' || !Number.isSafeInteger(item.index) || item.index < 0 ||
      typeof item.type !== 'string' || !item.type || !['sub', 'collection', 'file'].includes(String(scope.kind)) || typeof scope.name !== 'string') return;
  return { index: item.index, type: item.type, ...(typeof item.name === 'string' ? { name: item.name } : {}), scope: { kind: scope.kind as ProcessorFailure['scope']['kind'], name: scope.name } };
}

/** 只读取结构化错误信封；不从脚本文案猜测步骤或名称。 */
export function readSubStoreFailure(reason: unknown): SubStoreFailure {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : JSON.stringify(reason) ?? String(reason);
  let envelope: Record<string, unknown> = record(reason);
  if (!['failed', 'error'].includes(String(envelope.status))) {
    try { envelope = record(JSON.parse(message.replace(/^Sub-Store(?: HTTP \d+)?:\s*/, ''))); }
    catch { const source = record(reason); const processor = processorFailure(source.processor); const trace = readProcessorTrace(source.trace); return { message, ...(processor ? { processor } : {}), ...(trace ? { trace } : {}) }; }
  }
  if (!['failed', 'error'].includes(String(envelope.status))) return { message };
  const error = record(envelope.error);
  const detail = typeof error.details === 'string' && error.details ? error.details : typeof error.message === 'string' ? error.message : typeof envelope.error === 'string' ? envelope.error : message;
  const processor = processorFailure(error.processor);
  const trace = readProcessorTrace(error.trace);
  return { message: detail, ...(processor ? { processor } : {}), ...(trace ? { trace } : {}) };
}

export function subStoreError(reason: unknown): Error & { processor?: ProcessorFailure; trace?: ProcessorTrace } {
  const failure = readSubStoreFailure(reason);
  return Object.assign(new Error(failure.message), failure.processor ? { processor: failure.processor } : {}, failure.trace ? { trace: failure.trace } : {});
}
