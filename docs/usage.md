# palka: запуск, сделки и подготовка облачного теста

Актуально для интеграции 17 октября 2026. Это regtest-прототип с настоящими
Bitcoin/RGB-подписями, не mainnet-кошелёк. Public market, local client и
`packages/wallet/server.py` уже соединены. Старые разделы handoff-документов,
где sidecar отсутствует, описывают историю разработки.

## Что где работает

| Компонент | Где | Данные |
| --- | --- | --- |
| Public web | Локально или статический HTTPS-хостинг | Только открытые заявки, contract IDs, ссылки на локальный клиент |
| Market/coordinator | Общий сервер | Заявки, matching, сообщения участников, settlement packages, подписи, SQLite |
| Local client и wallet UI | У каждого участника | Приватная политика, pairing, подтверждения, сохранённое разрешение на подпись |
| Desktop | У каждого участника | Запускает local client; секреты остаются в main process; отдельный native dialog |
| Wallet sidecar + Rust RGB backend | У каждого участника | Ключи, BTC/RGB state, journal, consignments, резервирование и подпись |
| QVAC | У каждого участника | Модель и inference локально; нет облачного fallback |
| Bitcoin Core/electrs/RGB proxy | В локальном тесте — Docker | Общая regtest-цепь и индексатор; это отдельная инфраструктура от market |

Market не хранит seed, политику или полный баланс, но видит публичные материалы
сделки и её RGB proofs. Это не приватность транзакций от coordinator.
Подпись никогда не следует автоматически из публикации заявки или deep link.

## Требования и сборка

Работать из корня репозитория. Нужны RTK, Docker с Compose, Node 22.17,
Python 3.12+ с uv и Rust 1.94 с rustfmt/Clippy в PATH. `.nvmrc` и
`rust-toolchain.toml` фиксируют версии; npm устанавливает свой Node для scripts.

```sh
rtk proxy npm ci
rtk proxy uv sync --locked
rtk proxy uv run --locked python scripts/demo/bootstrap-native.py
rtk proxy cargo build --locked --manifest-path packages/wallet/native/Cargo.toml
rtk proxy npm run build
rtk proxy npm run build:desktop
```

Bootstrap материализует pinned rgb-lib и проверенную локальную cooperative
extension. При обновлении extension используйте `bootstrap-native.py --refresh`,
затем повторите cargo build. Это не создание и не пополнение кошелька.
QVAC при первой загрузке скачивает примерно 1.06 GB; последующий inference
локальный. Доступность модели отображается в UI; ручная форма работает отдельно.

## Инфраструктура: один раз и повторно

На **новой** машине без прежней цепи:

```sh
rtk proxy docker compose -f infra/compose.yaml up -d
rtk proxy uv run --locked python scripts/demo/chain-volumes.py pin
```

Для существующей цепи сначала `pin`, если это ещё не сделано; он записывает имена
существующих volumes, а не пересоздаёт их. Обычный запуск далее:

```sh
rtk proxy docker compose -f infra/compose.yaml -f infra/state/chain-volumes.compose.json up -d
rtk proxy uv run --locked python scripts/demo/chain-volumes.py verify
rtk proxy uv run --locked python scripts/demo/doctor.py
```

После холодного старта дождитесь успешного doctor. Сохраняйте containers/volumes;
не применяйте `down -v`, prune или новую цепь к старому RGB state. Root
`compose.yaml` — другой режим: web + runtime, без wallet sidecar. Для настоящего
обмена используйте host-launcher ниже, а не root Docker quickstart.

## Первое создание тестового набора

Выберите постоянный каталог под игнорируемым `packages/wallet/state`.
Следующие команды выполняются **один раз для нового набора**, а не при каждом
старте. Пример создаёт Alice/Bob/Carol на одной машине с независимыми ключами.

```sh
export RGB_DEMO_STATE="$PWD/packages/wallet/state/my-direct"
rtk proxy uv run --locked python scripts/demo/regtest.py setup
rtk proxy uv run --locked python scripts/demo/catalog.py
rtk proxy uv run --locked python scripts/demo/service-profile.py configure --source "$PWD" --base-port 44100
```

`setup` создаёт ключи, финансирует coinbase на regtest, ждёт зрелости и выпускает
100 X + 7 KEEP у Alice, 100 DUSD у Bob. Carol имеет BTC. `catalog` импортирует
проверенные публичные контракты всем участникам, включая активы с нулевым балансом.
DUSD не обеспечен долларом и не является USDT. Все тестовые RGB активы precision 0.
ID берётся из реального state; одинаковый ticker не означает одинаковый контракт.
Не копируйте IDs из mock fixtures или другого тестового набора.

`services/config.json` (0600) хранит стабильные токены и порты. Нельзя произвольно
менять source/base-port уже настроенного набора: launcher откажет. Для проверки
нового checkout существующего набора предусмотрен `RGB_SERVICE_SOURCE`; это не
миграция кошелька. Конфиг, журналы, pairing и backup не должны попадать в Git.

## Обычный запуск без повторной инициализации

В каждом новом терминале укажите **тот же** `RGB_DEMO_STATE`:

```sh
export RGB_DEMO_STATE="$PWD/packages/wallet/state/my-direct"
rtk proxy uv run --locked python scripts/demo/service-profile.py up
```

Одна команда запускает market, три sidecar, три local client и public Vite web.
Она не вызывает init/funding/issuance. Ctrl+C останавливает дочерние процессы,
сохраняя данные. Повторный запуск использует те же ключи, токены и SQLite.
Не запускайте второй экземпляр над тем же набором.

| Назначение | Адрес при base-port 44100 |
| --- | --- |
| Public web / market | `http://127.0.0.1:5173/` / `/market` |
| Coordinator | `http://127.0.0.1:44100` |
| Alice / Bob / Carol browser wallet | `http://127.0.0.1:44101/`, `:44102/`, `:44103/` |
| Их wallet RPC | `127.0.0.1:44111–44113`, только server-to-server |

Launcher печатает пути к `services/{profile}/pairing.json`. Откройте этот файл
локально, возьмите только `sessionToken`, нажмите **Pair local wallet** на странице
соответствующего профиля и введите его там. Не вводите токен на public web и
не отправляйте его в чат. Вкладка хранит его только в памяти; после reload нужно
повторное pairing. Wallet RPC token никогда не нужен браузеру.

Public web получает `MARKET_URL` и `VITE_LOCAL_WALLET_PORT` от launcher; все ссылки
на browser wallet ведут к Alice данного набора. Bob/Carol открывайте по их адресам.
Полный ID контракта можно сверить в публичной заявке и native signing dialog;
форма выбора активов использует проверенный wallet catalog, неоднозначный ticker
отклоняется при валидации.

Для desktop Alice остановите browser-runner и выполните:

```sh
rtk proxy uv run --locked python scripts/demo/service-profile.py up --desktop alice
```

Можно выбрать `bob` или `carol`. Для выбранного участника запускается Electron
вместо второго browser local-client. `PALKA_LOCAL_STATE_DIR` направляет его в ту же
локальную историю, поэтому переключение не теряет policy/approval/recovery.
Desktop подключается без ввода pairing; его локальный API использует отдельный
session token в main process. Не используйте старый browser pairing для desktop
API. При desktop-запуске открывайте его окно или offer deep link; ссылки browser
wallet предназначены для browser-режима. Другие два профиля остаются браузерными.

Отдельные процессы для диагностики: `service-profile.py market`,
`service-profile.py run --profile bob`, `service-profile.py health --profile bob`.
Не запускайте их одновременно с `up` для того же профиля. Для standalone desktop
доступны `npm run dev:desktop` и `npm run package:desktop`; они требуют отдельной
настройки `desktop-config.json` и сами sidecar не запускают.

## Заявки: QVAC или ручная форма

В Overview введите цель, например `Sell 100 X for at least 100 DUSD. Fee up to
1000 sats. Do not sell BTC.` Нажмите **Prepare order**, проверьте результат.
QVAC не определяет сумму подписи: детерминированный код повторно проверяет draft,
балансы, защищённые остатки, разрешённые активы, fee cap и срок действия.
При неоднозначном ответе или недоступной модели используйте **Fill in manually**.
В первоначальной проверке модель инвертировала DUSD → X в X → DUSD; код отклонил
черновик из-за отсутствия X у отправителя. При достаточном балансе такую ошибку
должен заметить пользователь при review: AI не является authority для намерения.
После перехода на короткие внутренние aliases прошла реальная проверка
`Sell 10 X for at least 10 DUSD. Maximum fee 1000 sats. Do not sell BTC. No protected balances or reserves.`
Используйте последнее уточнение только если действительно не задаёте новые резервы;
оно не отменяет ранее сохранённую private policy.

Поля сумм используют **atomic units**: BTC в sats, RGB в единицах контракта.
100000 sats = 0.001 BTC. В private policy явно разрешите BTC sale только если
заявка отдаёт BTC. Fee cap 1000 sats у каждой стороны; при этих тестах вся сделка
платит 1000 sats суммарно. Кнопка **Publish order** сначала проверяет draft, затем публикует его. Отдельный клик для проверки не нужен; подпись сделки запрашивается позже.

Direct на исходном наборе:

| Участник | Give | Receive at least | BTC sale |
| --- | --- | --- | --- |
| Alice | 100000 sats BTC | 100 DUSD | Да |
| Bob | 100 DUSD | 100000 sats BTC | Нет |

Для ring создайте **отдельный исходный набор** `my-ring`, например base-port 44200,
командами setup/catalog/configure выше. Не предполагается, что после direct
активы по-прежнему принадлежат исходным владельцам.

| Участник | Give | Receive at least | BTC sale |
| --- | --- | --- | --- |
| Alice | 100 X | 100 DUSD | Нет |
| Bob | 100 DUSD | 100000 sats BTC | Нет |
| Carol | 100000 sats BTC | 100 X | Да |

Matching сначала ищет direct, затем тройной цикл; заявки исполняются полностью.
У ring направления: Alice → Carol X, Bob → Alice DUSD, Carol → Bob BTC.
Это **одна общая Bitcoin-транзакция** с общим RGB commitment, не три перевода.

## Подготовка, подтверждение и результат

1. После matching UI автоматически готовит и проверяет пакет у каждого участника.
   Держите приложения всех участников открытыми. В **Trade** видны loader и этапы
   Prepare → Your approval → All wallets → Confirmation. funding → colored → proofs
   проходят без повторных нажатий. При уходе на Overview/Market работа продолжается;
   при закрытом приложении UI-loop остановлен и возобновится после запуска.
2. После проверки wallet появятся точные Give, Receive, комиссия и BTC change.
   Сверьте суммы и нажмите **Review & sign**. В desktop откроется native dialog
   с сетью, суммами и RGB contract ID. Автоматические запросы не создают разрешение
   на подпись. Отмена native dialog возвращает к проверке сделки.
3. Каждый участник отдельно разрешает подпись. Первое разрешение не подписывает
   за остальных. Не подменяйте пакет после первой подписи.
4. После всех подписей sidecar отправляет общую транзакцию. Regtest сам не майнит.
   Тестовый оператор подтверждает блоком (wallet `regtest-miner` создан setup):

```sh
rtk proxy docker compose -f infra/compose.yaml exec -T -u blits bitcoind bitcoin-cli -regtest -rpcwallet=regtest-miner -generate 1
```

Если после рестарта Core miner не загружен, один раз загрузите существующий:

```sh
rtk proxy docker compose -f infra/compose.yaml exec -T -u blits bitcoind bitcoin-cli -regtest loadwallet regtest-miner
```

5. Приложения сами проверяют Bitcoin confirmation и RGB acceptance. Market ставит
   CONFIRMED после совпадающих receipt всех сторон. После перезапуска UI читает
   сохранённый локальный receipt; один статус market не доказывает завершение.
   В **Transaction details** доступны txid и идентификатор плана.

## Восстановление и типовые ошибки

- Потеря ответа при подписи/отправке: UI читает сохранённый local intent и запускает
  recovery той же сделки. Local client повторяет только сохранённую неизменную
  авторизацию/подпись/финализацию. TTL не освобождает подписанные inputs.
- Запросы подготовки/проверки идут последовательно. При ошибке пауза увеличивается;
  после трёх ошибок автоматическое действие приостанавливается. Откройте **What
  happened?**, устраните причину и нажмите **Try again**. Обычное ожидание peer или
  блока не считается ошибкой. Сетевой snapshot продолжает обновляться.
- При временной ошибке `/state` новые публикации и подписи недоступны, но recovery
  продолжается. При общей потере связи последний экран сохраняется с предупреждением;
  действия с устаревшими балансами заблокированы.
- До подписи можно **Cancel swap**. Не подписавшие peers освобождают резерв при
  следующем snapshot/рестарте. После возможной подписи не удаляйте journal,
  не освобождайте резерв вручную и не создавайте новую сделку вместо recovery.
- Wallet unavailable: проверьте выбранный state, работающий sidecar, совпадение
  owner/token/port и doctor. Mock не включается автоматически.
- Pairing/Origin/Host: используйте точный `http://127.0.0.1:PORT/` данного профиля.
  Public origin и IP другой машины не подходят для wallet API.
- EADDRINUSE: остановите свой прежний runner; не удаляйте state. Порт 5173 общий
  для одного public web, поэтому два `up` одновременно конфликтуют по web.
- Contract mismatch / no match: сравните network + contract ID + precision,
  суммы и expiry. Один ticker на разных наборах не совпадает.
- Process killed с `rgb_runtime.lock`: сначала остановите профиль. Только затем
  применяйте `recover-sdk-lock.py --profile NAME` с правильным state; он проверяет
  project locks/identity/SQL-stock. Это не repair повреждённой базы.
- Backup: при остановленном coordinator выполните `backup.py` с тем же state.
  Backup содержит секреты, не зашифрован и остаётся локально в ignored state.
  Seed без RGB истории недостаточен; chain volumes сохраняются отдельно.

## Автоматические реальные сценарии

На **новом отдельно подготовленном** наборе после setup/catalog, без работающего
runner на его портах:

```sh
rtk proxy uv run --locked python scripts/demo/service-smoke.py --source "$PWD" --base-port 44300 --scenario direct --repeat --evidence-prefix my-integration
```

Для отдельного ring-набора замените base-port и `--scenario ring`. Скрипт проходит
реальные local-client/market/wallet API, явно подтверждает тестовые заявки и
подписи, майнит, сверяет реальные дельты и RGB acceptance, перезапускает профили
и расходует полученные RGB обратно. `--evidence-prefix` сохраняет новые результаты
отдельно от исторических. Это service evidence, не клики UI и не AI-сценарий.
Скрипт не предназначен для повторного запуска на незавершённой подписанной сделке.

```sh
rtk proxy npm run check
rtk proxy npm run smoke:qvac
```

`check` включает format, lint, typecheck, JS/Python unit tests и UI build.
Он не включает реальные переводы, native dialog или QVAC inference. Результаты
интеграции этой ветки и точные ограничения: [integration.md](integration.md).

## Облако и несколько компьютеров

Для первого server-only запуска используйте [deploy/README.md](../deploy/README.md):
Compose, настройка произвольных participant IDs, постоянные токены и команды
обновления уже находятся в Git. Этот HTTP-профиль запускает web + market;
приватный market доступен через SSH-туннель. TLS и распределённая Bitcoin/RGB
инфраструктура остаются отдельными этапами, описанными ниже.

Public web и market можно вынести в облако. Local client, QVAC, sidecar, ключи,
private policy и wallet state должны остаться **на машине каждого участника**.
Root Compose нельзя целиком выдавать за облачную архитектуру: его runtime также
запускает local wallet. Ни wallet RPC, ни pairing/API bearer нельзя публиковать.

Готово в коде: `MARKET_HOST`, `MARKET_PORT`, `MARKET_DB_PATH`, статическая карта
`MARKET_TOKENS_JSON` (token → owner); local client принимает `MARKET_URL`,
`MARKET_TOKEN`; HTTPS автоматически превращается в WSS для `/events`.
Desktop принимает `PALKA_MARKET_URL=https://market.example.org` (корневой origin,
без path/query), `PALKA_MARKET_TOKEN` и
`PALKA_PUBLIC_MARKET_URL=https://palka.example.org/market`.
Токен WebSocket идёт первым сообщением, не в URL. Public web credentials не получает.

План первого облачного развёртывания (ещё не выполнялся):

1. Один сервер Node 22.17 с постоянным диском под SQLite, process supervisor,
   отдельный market origin и TLS reverse proxy. Создать случайный отдельный
   market bearer для каждой identity (alice/bob/carol) и передать только владельцу.
   Карта credentials — серверный secret, не Vite env и не Git. Нет регистрации,
   токен refresh/отзыва через UI или привязки owner к криптографической identity;
   токены сейчас provisioned оператором. До публичного запуска нужны rate limits,
   лимиты соединений, журналирование без credentials и эксплуатационный backup.
2. Запустить `npm run dev:market` с `MARKET_HOST=127.0.0.1`, нужным портом,
   `MARKET_DB_PATH` и `MARKET_TOKENS_JSON` из private service environment. Разрешить
   снаружи только TLS reverse proxy. Проксировать HTTP API и `/events`, сохраняя
   Authorization; для WS нужны HTTP/1.1, Upgrade и Connection. Пример фрагмента:

```nginx
location / {
    proxy_pass http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

   Фрагмент находится внутри TLS server, сертификат и firewall настраиваются
   отдельно. Reconnect/replay клиентом предусмотрен. См. [официальный Nginx WS
   guide](https://nginx.org/en/docs/http/websocket.html).
3. Собрать `npm run build:web`, отдать `apps/web/dist` статическим HTTPS-хостом с
   SPA fallback. Настроить **только** `/market-api/health` и `/market-api/orders`
   как read-only proxy на общий market без Authorization/cookies/query/body,
   по образцу `docker/nginx.conf`. Private market API не проксируется через
   эти публичные пути. `VITE_LOCAL_WALLET_PORT` задаётся при build, обычно 4101.
4. На каждой машине отдельно запустить local client/desktop и sidecar, задать
   уникальную identity и её market bearer. `service-profile.py up` — однохостовый
   fixture launcher, не распределённый provisioner. Для cloud используйте env
   `LOCAL_OWNER_ID`, `LOCAL_STATE_DIR`, `LOCAL_PORT`, `MARKET_URL`, `MARKET_TOKEN`,
   `WALLET_MODE=real`, `WALLET_RPC_URL`, `WALLET_RPC_TOKEN` либо desktop equivalents.
5. Сначала проверить TLS health, публикацию/отмену одной тестовой заявки,
   доставку авторизованного snapshot/WS только участникам и reconnect.
   Затем отдельно провести settlement-сценарии ниже.

### Переход public web → локальный кошелёк

Ссылка `http://127.0.0.1:4101/` открывает кошелёк **компьютера посетителя**, не
облачного сервера. Это top-level navigation в отдельную вкладку, не cross-origin
fetch. HTTPS top-level переход сам по себе не считается mixed content; правила
локального доступа/предупреждения браузера всё равно нужно проверить в целевых
браузерах. См. [MDN mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)
и [local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access).

Public JavaScript не обращается к local API. Local API требует bearer, точный
loopback Host:port и свой Origin/Fetch Metadata. Добавление облачного домена в
`LOCAL_ALLOWED_ORIGINS` не открывает CORS: код также требует Origin == self.
Это сохраняет границу между публичной страницей и кошельком. Для desktop renderer
используется узкий IPC bridge, а HTTPS/WSS выполняет Node local client.

`palka://offer/order-UUID` переносит только ID заявки. Он выбирает её для просмотра,
не создаёт встречную заявку и не подписывает. Scheme объявлен в macOS bundle;
доставка через LaunchServices и подписанный/notarized дистрибутив остаются
проверкой перед распространением. В dev Electron надёжнее открыть окно вручную.

### Общая сеть и реальные активы: оставшаяся работа

Один облачный market **не соединяет разные regtest-цепи**. Все участники должны
видеть одну и ту же chain history и одинаковые RGB contract IDs. Нельзя запустить
`setup` независимо на трёх несвязанных chains и ожидать обмена.

Текущий backend намеренно привязан к regtest. Rust использует local electrs
`127.0.0.1:50001` и proxy `127.0.0.1:3000`; Python вызывает Bitcoin RPC через
`docker compose exec … bitcoin-cli`. Multi-host RPC transport и отдельное
onboarding/funding одного профиля ещё не реализованы. `catalog.py` также ожидает
три локальных профиля. Поэтому нижеследующий сценарий — критерий следующего этапа,
а не заявленная проверенная команда «развернуть всё на трёх ПК».

Необходимый небольшой инфраструктурный этап:

- Сделать Bitcoin RPC transport конфигурируемым (защищённый private network либо
  loopback через SSH tunnel), сохранив текущий Docker transport для local demo.
  Electrs/proxy можно оставить loopback через туннели либо параметризовать.
  Wallet RPC при этом всегда остаётся локальным.
- Разделить init одного профиля, выдачу публичных funding addresses, operator
  funding и импорт публичного RGB catalog. Wallet создаётся только у владельца;
  сервер не генерирует и не рассылает seed. Имена alice/bob/carol — уникальные
  market identities, разные локальные wallet IDs.
- Выбрать общий regtest Core + electrs, проверить общий checkpoint block hash;
  майнит только тестовый оператор. Не использовать публичный mainnet/signet:
  это потребует изменения wallet capabilities и проверок, а не только env.
- Выпустить X у Alice, DUSD у Bob; передать всем только публичные exported
  contracts и импортировать их через native catalog-import. Incoming ownership
  появляется после принятого consignment, а не после импорта genesis.

Воспроизводимый приёмочный сценарий после этого этапа:

| Шаг | 2 компьютера | 3 компьютера |
| --- | --- | --- |
| Identity / keys | Alice на ПК1, Bob на ПК2 | Добавить Carol на ПК3 |
| Сеть | Один checkpoint regtest у всех | Тот же checkpoint |
| Активы | DUSD Bob, BTC Alice, общий DUSD ID | X Alice, DUSD Bob, BTC Carol; общие X/DUSD IDs |
| Заявки | Таблица direct выше | Таблица ring выше, без direct пары |
| Проверка до подписи | Общие packageId/tx/commitment digests; суммы, fees, recipient scripts | Три funding/colored/proofs contributions в одном пакете |
| Подпись | Отдельное подтверждение на обоих ПК | Отдельное подтверждение на всех трёх |
| Результат | Один txid, mine, обе RGB acceptance, точные дельты | Один txid, три receipt, KEEP неизменен |
| Recovery | Рестарт после подписи; тот же intent/signature/txid; обратный обмен | То же для трёх участников |

В cooperative path consignments уже идут внутри authenticated settlement
materials через market, а не через общую файловую систему участников. Проверенный
размер укладывается в текущие 256 KiB market messages. Длинные RGB истории могут
потребовать отдельного согласованного транспорта. Наличие proxy health не означает,
что remote cooperative proxy delivery проверен: обычный SDK proxy smoke и этот
cooperative transport — разные сценарии.

Следующий безопасный milestone — закрытый облачный market + два/три локальных
кошелька на общей regtest-сети с перечисленными transport/onboarding изменениями.
Текущие deterministic blinding/nonce, фиксированная fee estimate, отсутствие
fee bumping/reorg recovery и security audit исключают production/mainnet запуск.
