import { useState } from 'react';
import type { CancellationPreview } from '@rgb-exchange/contracts';
import type { LocalClient } from './api';
import { Button } from './components/ui/wallet-kit';

export function CancellationPanel({
  client,
  tradeId,
  disabled,
  onChanged,
}: {
  client: LocalClient;
  tradeId: string;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (approve && preview) {
        await client.cancel(tradeId, preview.approvalDigest);
        setPreview(null);
      } else {
        setPreview(await client.previewCancellation(tradeId));
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Cancellation requires reconciliation.');
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <div className="cancellation-panel">
      {preview ? (
        <>
          <h3>Review on-chain cancellation</h3>
          <p>
            Spend one BTC input back to your wallet. Your RGB assets are not spent by this
            cancellation.
          </p>
          <dl className="approval-details">
            <div>
              <dt>Cancellation fee</dt>
              <dd>{preview.feeSats} sats</dd>
            </div>
            <div>
              <dt>BTC returned to you</dt>
              <dd>{preview.returnSats} sats</dd>
            </div>
          </dl>
          <p>
            The swap can still confirm first. Funds remain reserved until your wallet verifies the
            result.
          </p>
          <Button
            className="text-button danger"
            disabled={disabled || busy}
            loading={busy}
            loadingText="Submitting cancellation…"
            onClick={() => void run(true)}
          >
            Pay {preview.feeSats} sats & cancel
          </Button>
          <Button className="text-button" disabled={busy} onClick={() => setPreview(null)}>
            Keep waiting
          </Button>
        </>
      ) : (
        <Button
          className="text-button danger reject-button"
          disabled={disabled || busy}
          loading={busy}
          loadingText="Checking cancellation…"
          onClick={() => void run(false)}
        >
          Cancel signed swap…
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
