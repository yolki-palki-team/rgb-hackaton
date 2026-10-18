# N-party atomic swap milestone

This records work completed in the separate `codex/n-party-swaps` branch. It does
not enable N-party execution in `main`. Implementation checkpoint: `1366b9d`;
desktop graph refinement: `0e9a344`. The branch's full engineering report is
`docs/n-party-swaps.md` in that checkout.

## Implemented

- Trade schemas, cycle matching and wallet validation no longer impose a fixed
  two/three-participant limit. A valid plan must form one connected cycle with
  distinct owners; disconnected subcycles are rejected.
- Direct swaps retain priority. Matching uses exact BigInt amounts and a bounded
  iterative search; the default budget is 1,000,000 search steps. Exhaustion is an
  explicit error, not a false report that no cycle exists.
- Wallet capabilities distinguish legacy adapters (at most three participants),
  explicit participant limits and adapters without a fixed count limit.
- The desktop graph focuses on a selected wallet's incoming/outgoing transfers,
  with a scrollable overview of the complete cycle and exact amounts.

## Recorded verification

On 17 October 2026, four independent wallets completed a real regtest ring and a
reverse ring after restart through local-client HTTP, market HTTP/WebSocket,
wallet RPC and the native Bitcoin/RGB implementation. No direct pair existed.
Both runs had four signatures, one shared transaction, Bitcoin confirmation and
RGB acceptance by all four wallets. Actual balances matched the approved terms.

| Run                   | Evidence                                                          | Transaction size | Total fee  |
| --------------------- | ----------------------------------------------------------------- | ---------------- | ---------- |
| Four-party ring       | [Forward record](../scripts/demo/evidence/four-party.json)        | 573 vbytes       | 1,000 sats |
| Reverse after restart | [Reverse record](../scripts/demo/evidence/four-party-repeat.json) | 844 vbytes       | 1,000 sats |

The reverse record confirms preserved wallet identities and re-spending received
RGB inputs. Independent Bitcoin Core verification checked witnesses, inputs and
fees. These public JSON files are copied unchanged from the branch; their source
field identifies the original worktree, not a runtime dependency.

Separate synthetic tests covered 4, 6, 32 and 1,000-party matching, exact large
amounts, cycle validation and capability limits. The implementation passed the
full `npm run check`; the later graph refinement passed 102 JavaScript tests,
type checks, scoped lint/format checks and the local UI build. These are recorded
branch checks, not fresh checks of the current main branch.

## Limits and integration work

There is no fixed software hop cap, but transaction size, relay policy, fee caps,
search cost and wallet availability still limit usable rings. Dense graphs can
exhaust the search budget well below 1,000 participants. Real settlement beyond
four participants and multi-computer N-party execution remain unverified.

The branch uses full-order execution and retains the earlier regtest-only,
precision-0 NIA, SegWit v0 and fixed-fee scope. It predates current main's partial
fills and shared-contract multi-sender fixes. Those changes need integration and
combined verification before the extension can replace the main implementation.
The recorded settlement scenarios used manual drafts, not QVAC or desktop clicks.
