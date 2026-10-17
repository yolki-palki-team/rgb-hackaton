import { useEffect, useRef, useState } from 'react';
import type { AssetCode, Balance } from '../../model';
import { AssetDetails, AssetIcon, Button, Icon } from './wallet-kit';

export function AssetSelect({
  id,
  label,
  value,
  balances,
  onChange,
}: {
  id: string;
  label: string;
  value: AssetCode;
  balances: Balance[];
  onChange: (value: AssetCode) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = balances.find((balance) => balance.code === value);

  useEffect(() => {
    if (!open) return;
    const container = root.current;
    const option =
      container?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      container?.querySelector<HTMLButtonElement>('[role="option"]');
    option?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!container?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div
      ref={root}
      className="asset-select"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <label id={`${id}-label`} className="field-label" htmlFor={id}>
        {label}
      </label>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="asset-row asset-select-trigger"
        data-asset={value}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-options` : undefined}
        disabled={!balances.length}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (balances.length) setOpen(true);
          }
        }}
      >
        <span id={`${id}-value`} className="sr-only">
          {selected?.label ?? value}
        </span>
        {selected ? (
          <AssetDetails balance={selected} />
        ) : (
          <>
            <AssetIcon code={value} size="large" />
            <span className="asset-name">
              <strong>{value}</strong>
              <span>Unavailable</span>
            </span>
            <span className="asset-amount">—</span>
          </>
        )}
        <span className="asset-select-chevron">
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {open && (
        <ul
          id={`${id}-options`}
          role="listbox"
          aria-labelledby={`${id}-label`}
          className="asset-select-menu"
          onKeyDown={(event) => {
            const options = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
            );
            const current = options.indexOf(document.activeElement as HTMLButtonElement);
            let next: number;
            if (event.key === 'ArrowDown') next = (current + 1) % options.length;
            else if (event.key === 'ArrowUp')
              next = (current - 1 + options.length) % options.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = options.length - 1;
            else return;
            event.preventDefault();
            options[next]?.focus();
          }}
        >
          {balances.map((balance) => (
            <li key={balance.code} role="presentation">
              <Button
                role="option"
                aria-selected={balance.code === value}
                tabIndex={-1}
                className="asset-row asset-select-option"
                data-asset={balance.code}
                onClick={() => {
                  onChange(balance.code);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <AssetDetails balance={balance} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
