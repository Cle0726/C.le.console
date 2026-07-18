import type { HTMLAttributes } from 'react';
import clsx from 'clsx';

export interface BreathingHaloProps extends HTMLAttributes<HTMLSpanElement> {
  active?: boolean;
}

export function BreathingHalo({ active = false, className, ...props }: BreathingHaloProps) {
  if (!active) return null;

  return (
    <span
      aria-hidden="true"
      className={clsx('breathing-halo', className)}
      {...props}
    />
  );
}
