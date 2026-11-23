import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'default' | 'red' | 'blue' | 'ghost';
export type ButtonSize = 'lg' | 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  children: ReactNode;
}

/** Big, keyboard-focusable button. `type` defaults to "button" so it never submits by accident. */
export function Button({
  variant = 'default',
  size = 'lg',
  block = false,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const cls = ['btn', `btn--${variant}`, `btn--${size}`, block ? 'btn--block' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}
