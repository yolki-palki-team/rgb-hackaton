import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  Ref,
  SelectHTMLAttributes,
  TableHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import type { AssetCode, Balance } from '../../model';
import { cn } from '../../lib/utils';
import { MorphingSquare } from './morphing-square';

export function Button({
  className,
  type = 'button',
  loading = false,
  loadingText,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; loadingText?: string }) {
  return (
    <button
      type={type}
      className={cn('ui-button', className)}
      {...props}
      disabled={disabled || loading}
      aria-busy={loading ? true : props['aria-busy']}
    >
      {loading && <MorphingSquare className="h-4 w-4 bg-current" aria-hidden="true" />}
      {loading && loadingText ? loadingText : children}
    </button>
  );
}

export function WalletSkeleton() {
  return (
    <div className="wallet-skeleton" aria-hidden="true">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-composer" />
      <div className="overview-layout">
        <Panel className="panel">
          <div className="skeleton skeleton-heading" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="skeleton skeleton-offer" />
          ))}
        </Panel>
        <Panel className="panel">
          <div className="skeleton skeleton-heading" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="skeleton-asset">
              <div className="skeleton skeleton-avatar" />
              <div className="skeleton skeleton-asset-name" />
              <div className="skeleton skeleton-amount" />
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ui-panel', className)} {...props} />;
}

export function DataTable({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('ui-table', className)} {...props} />;
}

export function StatusBadge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('ui-status', className)} {...props} />;
}

export function AssetRow({ balance }: { balance: Balance }) {
  return (
    <li className="asset-row" data-asset={balance.code}>
      <AssetDetails balance={balance} />
    </li>
  );
}

export function AssetDetails({ balance }: { balance: Balance }) {
  return (
    <>
      <AssetIcon code={balance.code} size="large" />
      <span className="asset-name">
        <strong>{balance.label}</strong>
        <span>{balance.code}</span>
      </span>
      <span className="asset-amount">
        <span>{balance.amount}</span>
        <small>{balance.unit}</small>
      </span>
    </>
  );
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    arrows: (
      <>
        <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
      </>
    ),
    route: (
      <>
        <circle cx="5" cy="6" r="2" />
        <circle cx="19" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="M7 6h10M5 8v6l5 3m9-9v6l-5 3" />
      </>
    ),
    wallet: (
      <>
        <rect x="3" y="5" width="18" height="15" rx="3" />
        <path d="M16 11h5M5 5V4a2 2 0 0 1 2-2h11" />
        <circle cx="17" cy="14" r="1" />
      </>
    ),
    spark: (
      <>
        <path d="m12 2 1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2Z" />
        <path d="m19 18 .5 1.5L21 20l-1.5.5L19 22l-.5-1.5L17 20l1.5-.5L19 18Z" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 9 4v6c0 5.2-3.6 8.7-9 10-5.4-1.3-9-4.8-9-10V6l9-4Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    arrow: (
      <>
        <path d="M4 12h16m-6-6 6 6-6 6" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M5.5 9A7 7 0 0 1 18 6l2 1M4 17l2 1a7 7 0 0 0 12.5-3" />
      </>
    ),
    close: <path d="M5 5 19 19M19 5 5 19" />,
    info: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 11v6m0-10h.01" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

export function AssetIcon({
  code,
  size = 'normal',
}: {
  code: AssetCode;
  size?: 'normal' | 'large';
}) {
  const assetClass = code === 'BTC' ? 'btc' : code === 'DUSD' ? 'dusd' : 'x';
  return (
    <span
      className={`asset-icon ${assetClass} ${size === 'large' ? 'large' : ''}`}
      data-asset={code}
      aria-hidden="true"
    >
      {code === 'BTC' ? '₿' : code.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function SectionTitle({
  kicker,
  title,
  action,
  id,
}: {
  kicker: string;
  title: string;
  action?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="section-title">
      <div>
        <div className="eyebrow">{kicker}</div>
        <h2 id={id}>{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('ui-input', className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('ui-input', className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea className={cn('ui-input', className)} {...props} />;
}
