import clsx from 'clsx';
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';

export interface GlassCardProps extends ComponentPropsWithoutRef<'div'> {
  children: ReactNode;
  as?: ElementType;
}

export function GlassCard({ children, className, as: Component = 'div', ...props }: GlassCardProps) {
  return (
    <Component className={clsx('glass-card', className)} {...props}>
      {children}
    </Component>
  );
}
