import type { ReactNode } from 'react';

export interface PanelProps {
  title?: ReactNode;
  /** Small text on the right of the title row (status, counts…). */
  aside?: ReactNode;
  tone?: 'none' | 'red' | 'blue';
  className?: string;
  children?: ReactNode;
}

export function Panel({ title, aside, tone = 'none', className, children }: PanelProps) {
  const cls = ['panel', tone !== 'none' ? `panel--${tone}` : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <section className={cls}>
      {(title || aside) && (
        <header className="panel__head">
          {title && <span className="panel__title">{title}</span>}
          {aside && <span className="panel__aside">{aside}</span>}
        </header>
      )}
      {children}
    </section>
  );
}
