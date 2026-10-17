import { createContext, useContext } from 'react';
import type { ChangeEventHandler, ComponentProps, ReactNode } from 'react';
import { ArrowUp, LoaderCircle } from 'lucide-react';
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
  ...props
}: ComponentProps<typeof Textarea>) {
  const { value, onChange, onSubmit, loading, disabled, rows = 1 } = useContext(ChatInputContext);
  const ref = useTextareaResize(value, rows);
  return (
    <Textarea
      {...props}
      ref={ref}
      value={value}
      onChange={onChange}
      rows={rows}
      className={cn('chat-input-textarea', className)}
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
      onClick={() => context.onSubmit?.()}
    >
      {context.loading ? (
        <LoaderCircle aria-hidden="true" size={20} />
      ) : (
        <ArrowUp aria-hidden="true" size={20} />
      )}
    </Button>
  );
}
