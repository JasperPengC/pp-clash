import { Select } from '../ui';

export function ProcessorOption({ label, value, fallback, options, busy, change }: {
  label: string; value: unknown; fallback: string; options: { value: string; label: string }[]; busy: boolean; change: (value: string) => void;
}) {
  const current = value == null ? fallback : typeof value === 'string' ? value : JSON.stringify(value);
  const choices = options.some(option => option.value === current) ? options : [...options, { value: current, label: `当前值：${current}` }];
  return <label className="ss-field">{label}<Select ariaLabel={label} value={current} disabled={busy} options={choices} onChange={next => { if (next !== current) change(next); }} /></label>;
}
