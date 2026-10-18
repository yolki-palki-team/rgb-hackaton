import { createContext, Fragment, useContext, useEffect, useRef, useState } from 'react';
import type { ChangeEventHandler, ComponentProps, ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button, Textarea } from './wallet-kit';
import { cn } from '../../lib/utils';
import { useTextareaResize } from '../../hooks/use-textarea-resize';

interface ChatInputContextValue {
  value: string;
  onChange?: ChangeEventHandler<HTMLTextAreaElement>;
  onSubmit?: () => void;
  loading?: boolean;
  disabled?: boolean;
  rows?: number;
}

const ChatInputContext = createContext<ChatInputContextValue>({ value: '' });

export function ChatInput({
  children,
  className,
  ...context
}: ChatInputContextValue & { children: ReactNode; className?: string }) {
  return (
    <ChatInputContext.Provider value={context}>
      <div className={cn('chat-input', className)} aria-busy={context.loading}>
        {children}
      </div>
    </ChatInputContext.Provider>
  );
}

export function ChatInputTextArea({
  className,
  onKeyDown,
  examples,
  placeholder,
  highlightText,
  onScroll,
  ...props
}: ComponentProps<typeof Textarea> & { examples?: readonly string[]; highlightText?: string }) {
  const { value, onChange, onSubmit, loading, disabled, rows = 1 } = useContext(ChatInputContext);
  const ref = useTextareaResize(value, rows);
  const highlightsRef = useRef<HTMLDivElement>(null);
  const [example, setExample] = useState(examples?.[0] ?? '');

  useEffect(() => {
    const textarea = ref.current;
    const highlights = highlightsRef.current;
    if (!textarea || !highlights) return;
    const sync = () => {
      // Match the text area excluding its scrollbar, including after resizing.
      highlights.style.width = `${textarea.clientWidth}px`;
      highlights.style.height = `${textarea.clientHeight}px`;
      highlights.scrollTop = textarea.scrollTop;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [ref, value, highlightText]);

  useEffect(() => {
    if (value || !examples?.length) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let index = 0;
    let length = examples[0].length;
    let deleting = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      length += deleting ? -1 : 1;
      setExample(examples[index].slice(0, length));
      let delay = deleting ? 20 : 44;
      if (length === 0) {
        index = (index + 1) % examples.length;
        deleting = false;
        delay = 350;
      } else if (length === examples[index].length) {
        deleting = true;
        delay = 2000;
      }
      timer = setTimeout(tick, delay);
    };
    const onMotionChange = () => {
      clearTimeout(timer);
      if (motion.matches) setExample(examples[0]);
      else timer = setTimeout(tick, 2000);
    };
    if (!motion.matches) timer = setTimeout(tick, 2000);
    motion.addEventListener('change', onMotionChange);
    return () => {
      clearTimeout(timer);
      motion.removeEventListener('change', onMotionChange);
    };
  }, [examples, value]);

  const textarea = (
    <Textarea
      {...props}
      ref={ref}
      value={value}
      placeholder={examples?.length ? example : placeholder}
      onChange={onChange}
      rows={rows}
      className={cn('chat-input-textarea', className)}
      onScroll={(event) => {
        if (highlightsRef.current) highlightsRef.current.scrollTop = event.currentTarget.scrollTop;
        onScroll?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229)
          return;
        if (event.key !== 'Enter' || event.shiftKey || !onSubmit) return;
        event.preventDefault();
        if (!loading && !disabled && !props.disabled && value.trim()) onSubmit();
      }}
    />
  );

  if (!highlightText) return textarea;
  const parts = value.split(highlightText);
  return (
    <div className="chat-input-editor" data-highlighted={value.includes(highlightText)}>
      <div ref={highlightsRef} className="chat-input-highlights" aria-hidden="true">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 && <mark>{highlightText}</mark>}
            {part}
          </Fragment>
        ))}
        {'\n'}
      </div>
      {textarea}
    </div>
  );
}

export function ChatInputSubmit({ className, disabled, ...props }: ComponentProps<typeof Button>) {
  const context = useContext(ChatInputContext);
  return (
    <Button
      {...props}
      type="button"
      className={cn('chat-input-submit', className)}
      disabled={disabled || context.disabled || context.loading || !context.value.trim()}
      aria-label={context.loading ? 'Preparing order' : 'Prepare order'}
      loading={context.loading}
      onClick={() => context.onSubmit?.()}
    >
      {!context.loading && <ArrowUp aria-hidden="true" size={20} />}
    </Button>
  );
}
