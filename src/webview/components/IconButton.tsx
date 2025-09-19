import React from 'react';
import { Button, type ButtonProps } from './ui/button';
import { cn } from '../utils/cn';

type IconButtonProps = ButtonProps & {
  tooltip?: string;
  ariaLabel?: string;
};

export function IconButton({
  tooltip,
  ariaLabel,
  className,
  variant = 'ghost',
  size = 'icon',
  children,
  ...props
}: IconButtonProps) {
  return (
    <Button
      variant={variant}
      size={size}
      className={cn('text-muted-foreground hover:text-primary focus-visible:ring-ring', className)}
      title={tooltip}
      aria-label={ariaLabel ?? tooltip}
      {...props}
    >
      {children}
    </Button>
  );
}
