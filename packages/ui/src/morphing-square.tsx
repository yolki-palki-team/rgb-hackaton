import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import { twMerge } from 'tailwind-merge';

const morphingSquareVariants = cva('flex gap-2 items-center justify-center', {
  variants: {
    messagePlacement: {
      bottom: 'flex-col',
      top: 'flex-col-reverse',
      right: 'flex-row',
      left: 'flex-row-reverse',
    },
  },
  defaultVariants: { messagePlacement: 'bottom' },
});

export type MorphingSquareProps = HTMLMotionProps<'div'> &
  VariantProps<typeof morphingSquareVariants> & {
    message?: string;
    wrapperClassName?: string;
  };

export function MorphingSquare({
  message,
  messagePlacement,
  className,
  wrapperClassName,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel,
  role = 'status',
  ...props
}: MorphingSquareProps) {
  const reduceMotion = useReducedMotion();
  const hidden = ariaHidden === true || ariaHidden === 'true';
  return (
    <div
      className={twMerge(morphingSquareVariants({ messagePlacement }), wrapperClassName)}
      data-slot="morphing-square"
      role={hidden ? undefined : role}
      aria-hidden={ariaHidden}
      aria-label={hidden ? undefined : (ariaLabel ?? (message ? undefined : 'Loading'))}
    >
      <motion.div
        {...props}
        aria-hidden="true"
        className={twMerge('w-10 h-10 shrink-0 bg-foreground', className)}
        initial={{ borderRadius: '6%', rotate: 0 }}
        animate={
          reduceMotion
            ? { borderRadius: '6%', rotate: 0 }
            : { borderRadius: ['6%', '50%', '6%'], rotate: [0, 180, 360] }
        }
        transition={{
          duration: reduceMotion ? 0 : 2,
          repeat: reduceMotion ? 0 : Infinity,
          ease: 'easeInOut',
        }}
      />
      {message && <span>{message}</span>}
    </div>
  );
}

export default MorphingSquare;
