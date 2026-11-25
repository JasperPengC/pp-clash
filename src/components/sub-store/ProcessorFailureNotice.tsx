import type { SubStoreFailure } from '../../core/sub-store/failure';
import { PROCESSORS } from './processor-catalog';

export function ProcessorFailureNotice({ failure, busy, action, onLocate, onTrace }: { failure: SubStoreFailure; busy: boolean; action?: string; onLocate: () => void; onTrace?: () => void }) {
  const step = failure.processor;
  if (!step && !failure.trace) return null;
  const label = step && (step.name || PROCESSORS.find(item => item.type === step.type)?.label || step.type);
  return <div className="ss-failure-notice" role="alert">
    <div><strong>{step ? <>{step.scope.kind === 'sub' ? '来源' : step.scope.kind === 'collection' ? '组合' : '文件'}「{step.scope.name}」· 第 {step.index + 1} 步：{label}</> : '预览未完成'}</strong>
      <p>{failure.message}</p></div>
    {(action || onTrace) && <div className="ss-failure-actions">{action && <button className="btn btn-sm" disabled={busy} onClick={onLocate}>{action}</button>}{onTrace && <button className="btn btn-sm" disabled={busy} onClick={onTrace}>查看处理步骤</button>}</div>}
  </div>;
}
