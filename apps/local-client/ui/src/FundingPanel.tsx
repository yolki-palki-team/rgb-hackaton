import { useEffect, useState } from 'react';
import type { ClientStatus, FundingStatus, LocalClient } from './api';
import { Button, Input, Panel, SectionTitle, StatusBadge } from './components/ui/wallet-kit';

const sats = (value: string) => `${BigInt(value).toLocaleString()} sats`;

export function FundingPanel({
  client,
  wallet,
}: {
  client: LocalClient | null;
  wallet: ClientStatus | null;
}) {
  const [funding, setFunding] = useState<FundingStatus | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalAttempted, setApprovalAttempted] = useState(false);
  const eligible = Boolean(client && wallet?.mode === 'real' && wallet.network === 'regtest');
  const operation = funding?.operation ?? null;
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
    if (!client || !eligible) {
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const next = await client.fundingStatus();
        if (!active) return;
        setFunding(next);
        setError(null);
      } catch (caught) {
        if (active)
          setError(caught instanceof Error ? caught.message : 'Funding status is unavailable.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, eligible]);

  const create = async () => {
    if (!client || !eligible || !funding?.available || funding.address || busy || error) return;
    setBusy(true);
    setError(null);
    try {
      setFunding(await client.createFundingAccount());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the funding account.');
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    if (!client || !canPreview || !/^[1-9]\d*$/.test(amount)) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.previewFunding(amount);
      setFunding((current) => (current ? { ...current, operation: next } : current));
      setApprovalAttempted(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not prepare a funding preview.');
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!client || !operation || !canApprove) return;
    setApprovalAttempted(true);
    setBusy(true);
    setError(null);
    try {
      const next = await client.approveFunding(operation.id);
      setFunding((current) => (current ? { ...current, operation: next } : current));
    } catch (caught) {
      setError(
        `${caught instanceof Error ? caught.message : 'Funding approval result is unknown.'} Check status before taking another action.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    if (!client || !eligible || busy) return;
    setBusy(true);
    setError(null);
    try {
      setFunding(await client.syncFunding());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reconcile funding status.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="funding-section" aria-labelledby="funding-heading">
      <SectionTitle
        id="funding-heading"
        kicker="02 / BITCOIN FUNDING"
        title="Fund your exchange wallet"
        action={<StatusBadge>WDK · REGTEST</StatusBadge>}
      />
      <Panel className="funding-panel">
        <div className="funding-intro">
          <p>
            Use a separate local WDK Bitcoin account to send regtest BTC to your exchange wallet.
            This transfer has its own Bitcoin transaction and requires your approval.
          </p>
          <StatusBadge>
            {operation?.status ?? (funding?.address ? 'READY' : 'NOT SET UP')}
          </StatusBadge>
        </div>
        {!eligible ? (
          <p className="funding-message" role="status">
            Connect a real regtest wallet to use WDK funding. Mock and unpaired wallets cannot send
            BTC.
          </p>
        ) : error ? (
          <p className="funding-message" role="alert">
            {error}
          </p>
        ) : funding && !funding.available ? (
          <p className="funding-message" role="status">
            WDK funding unavailable: {funding.reason ?? 'The local funding service is not ready.'}
          </p>
        ) : !funding ? (
          <p className="funding-message" role="status">
            Checking the local WDK account…
          </p>
        ) : null}

        {eligible && funding?.available && !funding.address && (
          <div className="funding-step">
            <p>Create a dedicated local WDK account. Its keys remain in the local service.</p>
            <Button className="outline-button" onClick={() => void create()} disabled={busy}>
              Create WDK account
            </Button>
          </div>
        )}

        {eligible && funding?.available && funding.address && (
          <>
            <div className="funding-accounts">
              <div>
                <span className="funding-label">WDK funding account</span>
                <strong>
                  {funding.balanceSats === undefined
                    ? 'Balance unavailable'
                    : sats(funding.balanceSats)}
                </strong>
                <code>{funding.address}</code>
                <span>Receive regtest BTC at this address before funding the exchange wallet.</span>
              </div>
              <div>
                <span className="funding-label">Exchange wallet</span>
                <strong>Separate BTC and RGB balances above</strong>
                <span>Funding sends BTC here after your approval.</span>
              </div>
            </div>
            {canPreview && (
              <div className="funding-step">
                <label className="field-label" htmlFor="funding-amount">
                  Amount to send, in satoshis
                </label>
                <div className="funding-actions">
                  <Input
                    id="funding-amount"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="100000"
                  />
                  <Button
                    className="outline-button"
                    onClick={() => void preview()}
                    disabled={!/^[1-9]\d*$/.test(amount) || busy}
                  >
                    Review transfer
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {eligible && operation && (
          <div className="funding-review">
            <h3>
              {operation.status === 'PREVIEW' ? 'Review before sending' : 'Funding operation'}
            </h3>
            <dl>
              <div>
                <dt>Network</dt>
                <dd>{operation.network}</dd>
              </div>
              <div>
                <dt>Destination, exchange wallet</dt>
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
                  <dt>Bitcoin transaction</dt>
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
                Preview expires {new Date(operation.expiresAt).toLocaleString()}. Confirm the
                destination and fee before sending.
              </p>
            )}
            <div className="funding-actions">
              {operation.status === 'PREVIEW' && (
                <Button
                  className="primary-button"
                  onClick={() => void approve()}
                  disabled={!canApprove}
                >
                  Approve and send BTC
                </Button>
              )}
              <Button className="outline-button" onClick={() => void sync()} disabled={busy}>
                Check status
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
}
