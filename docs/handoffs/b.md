# B — wallet/settlement handoff

2026-10-17: оба реальных regtest-сценария подписаны после явного согласия,
опубликованы, подтверждены mining и проверены по actual BTC / RGB stock balances.
Каждый использует одну общую Bitcoin-транзакцию.

- Direct: `542ce6b9ac3a44b355f6caa385f4245a2917f8f5d3ff17dd1378241a24f3ee92`.
  Alice +100 DUSD / −100500 sats; Bob −100 DUSD / +99500 sats.
- Ring: `32aba60bde94c32d5191dee36d8b358059a3d8bbe0a055cf8e3a8c41c863849f`.
  Alice −100 X / +100 DUSD / −333 sats; Bob −100 DUSD / +99667 sats;
  Carol +100 X / −100334 sats. Все 7 KEEP на расходуемом X-UTXO сохранены.
- Комиссия каждого сценария 1000 sats. Incoming consignments проверены до
  подписей. Повторный execute обоих пакетов вернул прежние txid и балансы.

Полный [capability report](../settlement.md), публичные
[direct evidence](../../scripts/demo/evidence/direct.json) и
[ring evidence](../../scripts/demo/evidence/ring.json). Ключей/полных балансов
в этих evidence нет; private state и backup находятся в ignored state.

## Boundary для A

Локальный Node bridge: `packages/wallet/adapter.mjs`,
`createWalletAdapter({profile,stateDir,binary})`, методы `capabilities()`,
`identity()`, `state()`. JS-зависимости не нужны; root manifest/lock и contracts
не менялись. Native manifest/lock отдельный.

**Готовность интеграции ещё не достигнута.** CLI proof работает, production
adapter возвращает `directAtomic:false`, `ringAtomic:false`, `sign:false` и
блокирует prepare/sign/broadcast. После low-level settlement RGB stock корректен,
но SQL allocation/transfer index SDK ещё не синхронизирован для общего повторного
расходования. Не включать UI settlement на основе txid proof. Для read-only
отображения использовать `stockBalances`, а не SDK SQL balances.

Следующий шаг: синхронизировать SDK allocation index, затем адаптировать fixture
orchestration к согласованному TradePlan + local approval lifecycle. Реальные
payload и порядок — `scripts/demo/cooperative.py`, `review.py`; описание в report.
Не нужен придуманный API поверх `sendBegin`.

Pinned rgb-lib `0.3.0-beta.7`, commit
`1eaf0024c591e41843eb80cc8834082292668871`, с выделенным local extension.
Upstream `inspect_rgb_transfer` отвергает чужие входы общей PSBT:
`found a PSBT input that does not belong to this wallet`.
Reproducer: `rtk proxy python3 scripts/demo/check-upstream-limit.py`.

17 negative SDK checks, 8 journal tests и 3 adapter tests прошли; Rust build/test
прошёл (Rust unit tests пока нет). Ограничения и команды запуска — в report.
QVAC/UI/general market integration не проверялись B.

Main state — подписанный ring, `state/direct-fixture` — direct. Не готовить новые
пакеты поверх них; recovery только с прежним approval digest. Новые сценарии —
в отдельных ignored directories с новым согласием перед подписью. Не удалять
Docker volumes или wallet state.

B меняет только `packages/wallet`, `infra`, `scripts/demo`, `docs/settlement.md`
и этот handoff. Финализированные результаты публикуются отдельной веткой и PR
по поручению пользователя; общий checkout не переключается. A может добавить
в принадлежащий ему README ссылку на report и разделить CLI proof и интеграцию.
