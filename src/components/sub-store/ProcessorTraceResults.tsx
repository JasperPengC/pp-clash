import { useState } from 'react';
import type { ProcessorTrace, ProcessorTraceStep } from '../../core/sub-store/trace';
import { EmptyState } from '../ui';
import { PROCESSORS } from './processor-catalog';

const statuses = { success: '完成', skipped: '已跳过', failed: '失败', 'not-run': '未执行' };
const reasons = { disabled: '已禁用', context: '脚本控制跳过', 'response-transformer': '响应转换不在此阶段执行' };
const scopes = { sub: '来源', collection: '组合', file: '文件' };
const duration = (ms: number) => ms === 0 ? '0 ms' : ms < 0.1 ? '<0.1 ms' : `${Number(ms.toFixed(1))} ms`;
function Step({ step }: { step: ProcessorTraceStep }) {
  const label = step.name || PROCESSORS.find(item => item.type === step.type)?.label || step.type;
  return <li className="ss-trace-step" data-status={step.status}>
    <div className="ss-trace-name"><span>第 {step.index + 1} 步</span><strong>{label}</strong></div>
    <span className="ss-trace-status">{statuses[step.status]}</span>
    <div className="ss-trace-measure">
      {step.inputCount !== undefined && <span>{step.outputCount !== undefined ? `${step.inputCount} → ${step.outputCount} 个节点` : `输入 ${step.inputCount} 个节点`}</span>}
      {step.durationMs !== undefined && <span>{duration(step.durationMs)}</span>}
      {step.skipReason && <span>{reasons[step.skipReason]}</span>}
    </div>
  </li>;
}
export function ProcessorTraceResults({ trace }: { trace: ProcessorTrace }) {
  const [limit, setLimit] = useState(80);
  const total = trace.chains.reduce((sum, chain) => sum + chain.steps.length, 0);
  let remaining = limit;
  return <div className="ss-trace">
    <p className="ss-hint">仅列出本次进入的处理链。耗时包含脚本加载与执行，不含来源下载；不同来源可能并行处理。</p>
    {trace.truncated && <p className="ss-hint" role="status">轨迹较长，部分步骤未展示。已保留可用记录，失败位置以错误提示为准。</p>}
    <div className="ss-trace-list">{trace.chains.map((chain, index) => {
      const shown = chain.steps.slice(0, Math.max(0, remaining)); remaining -= shown.length;
      if (!shown.length) return null;
      return <section className="ss-trace-chain" key={index} aria-label={`${scopes[chain.scope.kind]}「${chain.scope.name}」`}>
        <h4>{scopes[chain.scope.kind]}「{chain.scope.name}」</h4><ol>{shown.map(step => <Step key={step.index} step={step} />)}</ol>
      </section>;
    })}{!total && <EmptyState compact title="没有已记录的处理步骤" desc="本次没有进入包含处理器的处理链。" />}</div>
    {total > 0 && <div className="ss-preview-pagination"><span>显示 {Math.min(limit, total)} / {total} 步</span>{limit < total && <button className="btn btn-sm" onClick={() => setLimit(current => current + 80)}>显示更多步骤</button>}</div>}
  </div>;
}
