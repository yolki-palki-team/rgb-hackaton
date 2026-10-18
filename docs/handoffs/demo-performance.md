# Demo wallet preparation performance

Measured on 2026-10-18 against clean `main` commit `838b2c9`. The mean total time
to validate an already prepared package across every participant fell by **43.7%
for direct swaps** and **41.3% for three-party rings** in the isolated local
regtest comparison below.

## Change and safety

`Backend.validate` previously loaded a fresh wallet state, then opened another
native wallet for `preflight-sign`. Each call performed the SDK's full colored
and vanilla consistency scans. Preflight now returns its own checked balance
snapshot, so the preview and signing preflight share one native wallet session.
Standalone `state` also reads its BTC balance and UTXOs from the snapshot that
the immediately preceding full consistency scan synchronized.

Every validation still opens a fresh native wallet and runs
`go_online(skip_consistency_check=false)`. Allocation-index checks, owned input
and amount checks, incoming RGB proof validation, outgoing RGB conservation,
recipient scripts, fees, immutable approval bytes and `SIGHASH_ALL` remain in
place. Actual signing independently repeats its existing checks. There is no
cached state across requests, persistent native process, new dependency or
network configuration change.

Update the Python sidecar and native binary together. An older binary lacks the
required preflight snapshot and validation fails closed; it cannot fall back to
an unchecked balance.

## Measurement

Environment: macOS arm64, Python 3.12.6, Rust 1.94.0 debug binaries, pinned
`rgb-lib` commit `1eaf0024c591e41843eb80cc8834082292668871`, and the existing local
Bitcoin Core/electrs/RGB proxy containers on ports 18443/50001/3000. Both
binaries were built with the same clean-main manifest, lockfile and SDK bridge.

The unmodified baseline binary was saved before applying the four-file wallet
change. Three new isolated wallets received mature regtest coinbases and real
X, DUSD and KEEP test assets. Real cooperative preparation produced direct and
ring packages. The harness alternated baseline and optimized `Backend.validate`
calls twice per participant, measuring wall time after backend initialization.
All **20 validations** returned exactly equal previews, including amounts,
fees, commitments and resulting BTC/RGB balances. Neither benchmark signed nor
broadcast a swap.

| Scenario                 | Baseline total per iteration | Optimized total per iteration | Mean reduction |
| ------------------------ | ---------------------------- | ----------------------------- | -------------- |
| Direct, two participants | 3.324 s; 3.345 s             | 1.858 s; 1.898 s              | 43.7%          |
| Ring, three participants | 5.155 s; 5.152 s             | 3.074 s; 2.974 s              | 41.3%          |

Per-participant samples in seconds, each pair representing the two iterations:

| Scenario / participant | Baseline     | Optimized    |
| ---------------------- | ------------ | ------------ |
| Direct / Alice         | 1.716; 1.717 | 0.952; 0.979 |
| Direct / Bob           | 1.608; 1.628 | 0.906; 0.919 |
| Ring / Alice           | 1.843; 1.879 | 1.176; 1.145 |
| Ring / Bob             | 1.632; 1.624 | 0.913; 0.892 |
| Ring / Carol           | 1.680; 1.649 | 0.985; 0.937 |

Separate baseline/optimized `state` calls on all three funded wallets returned
identical decoded BTC, RGB and UTXO state. Their times were 0.817/0.752 s for
Alice, 0.749/0.645 s for Bob and 0.745/0.618 s for Carol (baseline/optimized).

The local samples and private fixtures are retained under the ignored
`packages/wallet/state/performance-regtest-main-20261018/` directory. No wallet
keys, private state or test-funding data are included in this report.

## Checks and limits

The wallet suite passed all 32 Python tests, including repeated fresh preflight
reads and review rollback when its snapshot is missing or malformed. Native
compilation, Clippy with warnings denied, rustfmt, and focused
Ruff formatting/lint checks passed. An independent source review confirmed that
the pinned SDK's retained consistency check synchronizes both keychains before
the snapshot read.

These are small, alternating local samples of the wallet validation stage.
Totals sum sequential participant calls; they are not measured desktop latency
or complete transaction latency. UI polling, public infrastructure, QVAC,
network confirmation time, signing and settlement are outside this benchmark.
