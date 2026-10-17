import { useEffect, useState } from 'react';
import type { ClientStatus, FundingStatus, LocalClient } from './api';
import { ArrowDown, ArrowRight, Bitcoin } from 'lucide-react';
import { Button, Input, Panel, StatusBadge } from './components/ui/wallet-kit';
import { MorphingSquare } from './components/ui/morphing-square';

const sats = (value: string) => `${BigInt(value).toLocaleString()} sats`;

export function FundingPanel({
  client,
  wallet,
  visible = true,
}: {
  client: LocalClient | null;
  wallet: ClientStatus | null;
  visible?: boolean;
}) {
  const [funding, setFunding] = useState<FundingStatus | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<'create' | 'preview' | 'approve' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalAttempted, setApprovalAttempted] = useState(false);
  const eligible = Boolean(client && wallet?.mode === 'real' && wallet.network === 'regtest');
  const operation = funding?.operation ?? null;
  const expired = operation?.status === 'PREVIEW' && operation.expiresAt <= Date.now();
  const canPreview =
    eligible &&
    funding?.available &&
    funding.address &&
    !busy &&
    !error &&
    (!operation || operation.status === 'PREVIEW' || operation.status === 'CONFIRMED');
  const canApprove =
    operation?.status === 'PREVIEW' &&
    operation.expiresAt > Date.now() &&
    !approvalAttempted &&
    eligible &&
    funding?.available &&
    !busy &&
    !error;

  useEffect(() => {
    setFunding(null);
    setError(null);
    setApprovalAttempted(false);
  }, [client, eligible]);

  useEffect(() => {
    if (!client || !eligible || !visible) {
      return;
    }
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await client.fundingStatus();
        if (!active) return;
        setFunding(next);
        setError(null);
      } catch (caught) {
        if (active)
          setError(caught instanceof Error ? caught.message : 'Funding status is unavailable.');
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, eligible, visible]);

  const create = async () => {
    if (!client || !eligible || !funding?.available || funding.address || busy || error) return;
    setBusy('create');
    setError(null);
    try {
      setFunding(await client.createFundingAccount());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the funding account.');
    } finally {
      setBusy(null);
    }
  };

  const preview = async () => {
    if (!client || !canPreview || !/^[1-9]\d*$/.test(amount)) return;
    setBusy('preview');
    setError(null);
    try {
      const next = await client.previewFunding(amount);
      setFunding((current) => (current ? { ...current, operation: next } : current));
      setApprovalAttempted(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not prepare a funding preview.');
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!client || !operation || !canApprove) return;
    setApprovalAttempted(true);
    setBusy('approve');
    setError(null);
    try {
      const next = await client.approveFunding(operation.id);
      setFunding((current) => (current ? { ...current, operation: next } : current));
    } catch (caught) {
      setError(
        `${caught instanceof Error ? caught.message : 'Funding approval result is unknown.'} Check status before taking another action.`,
      );
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    if (!client || !eligible || busy) return;
    setBusy('sync');
    setError(null);
    try {
      setFunding(await client.syncFunding());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reconcile funding status.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="funding-section" aria-labelledby="funding-heading">
      <div className="funding-heading">
        <h1 id="funding-heading">Top up</h1>
        <p>Test BTC from WDK to your exchange wallet.</p>
      </div>
      <Panel className="funding-panel">
        <div className="funding-topline">
          <span className="funding-token">
            <Bitcoin aria-hidden="true" size={22} /> Bitcoin
          </span>
          <StatusBadge>REGTEST ONLY</StatusBadge>
        </div>
        {!eligible ? (
          <p className="funding-message" role="status">
            Connect a real regtest wallet to top up.
          </p>
        ) : error ? (
          <p className="funding-message" role="alert">
            {error}
          </p>
        ) : funding && !funding.available ? (
          <p className="funding-message" role="status">
            {funding.reason ?? 'The local funding service is not ready.'}
          </p>
        ) : !funding && visible ? (
          <MorphingSquare
            message="Loading your WDK account…"
            wrapperClassName="funding-message py-8"
          />
        ) : null}

        {eligible && funding?.available && !funding.address && (
          <div className="funding-step">
            <p>Create a local funding account to get started.</p>
            <Button
              className="primary-button full"
              onClick={() => void create()}
              disabled={Boolean(busy) || Boolean(error)}
              aria-busy={busy === 'create'}
            >
              {busy === 'create' && (
                <MorphingSquare className="h-4 w-4 bg-current" aria-hidden="true" />
              )}
              {busy === 'create' ? 'Creating…' : 'Create WDK account'}
            </Button>
          </div>
        )}

        {eligible && funding?.available && funding.address && (
          <>
            <div className="funding-balance">
              <span>Available in WDK</span>
              <strong>
                {funding.balanceSats === undefined ? 'Unavailable' : sats(funding.balanceSats)}
              </strong>
            </div>
            <details className="funding-receive">
              <summary>
                <ArrowDown aria-hidden="true" size={14} /> Receive BTC
              </summary>
              <p>Send regtest BTC to this WDK address.</p>
              <code>{funding.address}</code>
            </details>
            {(!operation || operation.status === 'PREVIEW' || operation.status === 'CONFIRMED') && (
              <div className="funding-step">
                <label className="field-label" htmlFor="funding-amount">
                  Amount in sats
                </label>
                <Input
                  id="funding-amount"
                  className="funding-amount"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0"
                  disabled={Boolean(busy)}
                />
                <Button
                  className="primary-button full"
                  onClick={() => void preview()}
                  disabled={!canPreview || !/^[1-9]\d*$/.test(amount)}
                  aria-busy={busy === 'preview'}
                >
                  {busy === 'preview' ? (
                    <>
                      <MorphingSquare className="h-4 w-4 bg-current" aria-hidden="true" />
                      Please wait…
                    </>
                  ) : (
                    <>
                      Review top up <ArrowRight aria-hidden="true" size={16} />
                    </>
                  )}
                </Button>
              </div>
            )}
          </>
        )}

        {eligible && expired && (
          <p className="funding-message">Preview expired. Review a new amount.</p>
        )}

        {eligible && operation && !expired && (
          <div className="funding-review">
            <div className="funding-review-heading">
              <h2>{operation.status === 'PREVIEW' ? 'Review top up' : 'Transfer'}</h2>
              <StatusBadge>{operation.status}</StatusBadge>
            </div>
            <dl>
              <div>
                <dt>Network</dt>
                <dd>{operation.network}</dd>
              </div>
              <div>
                <dt>To your wallet</dt>
                <dd className="funding-address">{operation.address}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{sats(operation.amountSats)}</dd>
              </div>
              <div>
                <dt>Estimated fee</dt>
                <dd>{sats(operation.feeSats)}</dd>
              </div>
              <div>
                <dt>Maximum fee</dt>
                <dd>{sats(operation.maxFeeSats)}</dd>
              </div>
              {operation.txid && (
                <div>
                  <dt>Transaction</dt>
                  <dd className="funding-address">{operation.txid}</dd>
                </div>
              )}
            </dl>
            {operation.reason && (
              <p className="funding-message" role="status">
                {operation.reason}
              </p>
            )}
            {operation.status === 'PREVIEW' && (
              <p className="funding-message">
                Expires {new Date(operation.expiresAt).toLocaleTimeString()}. Check the address and
                fee.
              </p>
            )}
            <div className="funding-actions">
              {operation.status === 'PREVIEW' && (
                <Button
                  className="primary-button"
                  onClick={() => void approve()}
                  disabled={!canApprove}
                  aria-busy={busy === 'approve'}
                >
                  {busy === 'approve' && (
                    <MorphingSquare className="h-4 w-4 bg-current" aria-hidden="true" />
                  )}
                  {busy === 'approve' ? 'Waiting for approval…' : 'Approve & send BTC'}
                </Button>
              )}
              <Button
                className="outline-button"
                onClick={() => void sync()}
                disabled={Boolean(busy)}
                aria-busy={busy === 'sync'}
              >
                {busy === 'sync' && (
                  <MorphingSquare className="h-4 w-4 bg-current" aria-hidden="true" />
                )}
                {busy === 'sync' ? 'Checking status…' : 'Check status'}
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
}
