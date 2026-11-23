export interface MeterProps {
  label: string;
  /** `null` renders an empty bar with "—". */
  value: number | null | undefined;
  min?: number;
  max?: number;
  /** CSS color for the fill. */
  color?: string;
  /** Vertical tick marks, in value units (e.g. thresholds). */
  marks?: number[];
  format?: (v: number) => string;
  hint?: string;
}

/** Horizontal bar with label + numeric readout. Pure presentational; safe to re-render at 15 Hz. */
export function Meter({ label, value, min = 0, max = 1, color, marks, format, hint }: MeterProps) {
  const has = typeof value === 'number' && Number.isFinite(value);
  const span = max - min || 1;
  const frac = has ? Math.min(1, Math.max(0, ((value as number) - min) / span)) : 0;
  const text = has ? (format ? format(value as number) : (value as number).toFixed(2)) : '—';
  return (
    <div className="meter" role="meter" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={has ? (value as number) : undefined}>
      <span className="meter__label">{label}</span>
      <span className="meter__bar">
        <span className="meter__fill" style={{ width: `${frac * 100}%`, background: color }} />
        {marks?.map((m) => (
          <span key={m} className="meter__mark" style={{ left: `${Math.min(100, Math.max(0, ((m - min) / span) * 100))}%` }} />
        ))}
      </span>
      <span className="meter__value">{text}</span>
      {hint && <span className="meter__hint">{hint}</span>}
    </div>
  );
}
