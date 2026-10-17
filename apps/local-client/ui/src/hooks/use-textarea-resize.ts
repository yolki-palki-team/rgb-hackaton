import { useEffect, useRef } from 'react';

export function useTextareaResize(value: string, rows: number) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 400)}px`;
  }, [value, rows]);
  return ref;
}
