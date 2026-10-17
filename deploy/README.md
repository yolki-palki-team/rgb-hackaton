# Серверная демка palka

Этот каталог запускает **public web + market + SQLite** на отдельной VM.
Desktop, local client, QVAC и wallet sidecar работают на компьютерах участников.
Bitcoin Core/electrs/RGB proxy и настройка независимых кошельков сюда пока не
входят. Это не команда запуска распределённого settlement и не mainnet deployment.
Оставшаяся работа описана в [общей инструкции](../docs/usage.md#облако-и-несколько-компьютеров).

## Требования и изоляция

- Git, Bash, Python 3.9+, curl, Docker Engine 25+, Compose 2.20.2+.
- Пользователь уже имеет доступ к Docker; команды не требуют sudo или RTK.
- Свободные host-порты: `80` для public web и `127.0.0.1:44100` для market.
- Отдельный Compose project **palka-demo**, сеть и volume
  **palka-demo_market-state**. Контейнеры других проектов не управляются этими
  скриптами, но CPU, RAM и диск машины остаются общими.
- Логи ограничены тремя файлами по 10 MB на сервис. Сборки последовательные.
- Отдельный `deploy/Dockerfile` и npm lockfile устанавливают только серверные/web
  зависимости. Electron, QVAC, WDK и модель не устанавливаются. Web собирает только
  публичный UI; runtime market не содержит React/Vite.
- ARM64-сборка проверена на отдельном Docker-хосте: market около 258 MB,
  web около 52 MB (размеры распакованных образов, без build cache и ОС).
  Сам Oracle-сервер этим тестом не проверяется. Не добавляйте
  `platform: linux/amd64` для обхода ошибки без проверки причины.

## Первый запуск

На сервере, в отдельной папке:

```bash
mkdir -p ~/palka-demo
cd ~/palka-demo
git clone --branch main https://github.com/yolki-palki-team/rgb-hackaton.git repo
cd repo

bash deploy/server.sh init participant-1 participant-2
bash deploy/server.sh up
bash deploy/server.sh check
```

Замените `participant-1 participant-2` на выбранные ID участников. Для существующего
кошелька используйте его owner ID: market, local client и sidecar должны совпадать.
Приватный репозиторий требует настроенной GitHub-аутентификации.
Если тестовый контейнер `palka-netcheck` ещё занимает порт 80, перед запуском
остановите только его: `docker stop palka-netcheck`.

Откройте `http://SERVER_IP/market` с другого компьютера. Команда `check` проверяет
только доступ на самом сервере; внешние правила Oracle проверяются этим отдельным
запросом. Пустой список заявок на новой базе — ожидаемый результат.

## Участники и токены

Alice/Bob/Carol — имена участников локальных тестовых сценариев, а не роли
протокола. Direct использует два ордера, ring — три; сервер может обслуживать
больше участников. Здесь пользователей по умолчанию нет.

Market пока использует статическую карту `bearer token → owner ID`. Она нужна,
чтобы разрешать изменение своих заявок и доступ к своим событиям/сделкам.
Owner ID не является seed, адресом Bitcoin или доказательством владения ключом.
Публичные заявки доступны без токена. Самостоятельной регистрации в MVP пока нет;
оператор добавляет участника и выдаёт ему отдельный токен.

```bash
# Можно повторять: существующие токены и участники сохранятся.
bash deploy/server.sh init participant-3

# Применить изменённую карту без пересборки образов.
bash deploy/server.sh start

# Показывает секрет только одного участника — передайте только его владельцу.
bash deploy/server.sh user participant-3
```

`user` выводит `PALKA_OWNER_ID` и `PALKA_MARKET_TOKEN`. Настройте их в локальном
desktop вместе с его существующими wallet RPC credentials. `init` не создаёт
кошельки, не пополняет их и не выпускает RGB-активы.

Карта хранится в `deploy/.state/market.env` с правами `0600`; каталог имеет права
`0700`. Он исключён из Git через `.state/` и не входит в Docker build context.
Не отправляйте этот файл или вывод `user` в чат/логи. Обычный `init` ничего
секретного не печатает. Повреждённый файл не заменяется новыми токенами автоматически.

## Подключение desktop до настройки HTTPS

Public web доступен по HTTP, приватный market опубликован только на loopback
сервера. Не отправляйте market token по открытому HTTP через интернет.
Для закрытой демки можно открыть SSH-туннель **на ноутбуке**:

```bash
ssh -N \
  -L 54100:127.0.0.1:44100 \
  -L 55173:127.0.0.1:80 \
  beknur@SERVER_IP
```

В локальной конфигурации desktop:

```text
PALKA_MARKET_URL=http://127.0.0.1:54100
PALKA_PUBLIC_MARKET_URL=http://127.0.0.1:55173/market
```

Каждый участник открывает свой туннель, используя свой разрешённый SSH-доступ.
Это соединяет desktop с market, но не решает удалённый Bitcoin RPC transport.
Для прямого подключения без туннеля нужен отдельный HTTPS market origin и WSS
`/events`, сохраняющие Authorization. Текущий public Nginx проксирует только
read-only `/market-api/health` и `/market-api/orders`; приватные маршруты на нём
намеренно отсутствуют. TLS, DNS, rate limits и автоматический backup в этом
первом HTTP-профиле не настроены.

## Обновление и остановка

```bash
cd ~/palka-demo/repo
git pull --ff-only
bash deploy/server.sh up
bash deploy/server.sh status
bash deploy/server.sh logs

# Остановка только palka-demo. Volume с базой сохраняется.
bash deploy/server.sh down

# Повторный запуск существующих образов без сборки.
bash deploy/server.sh start
```

Токены и база сохраняются при обновлении и пересоздании контейнеров. Не запускайте
`down --volumes`, общий `docker system prune` или удаление volumes ради обновления.
Храните резервную копию credentials и согласованную копию SQLite (проще копировать
её после остановки market); wallet backup делается отдельно на компьютере владельца.

## Если уже использовали команды с compose.server.yaml

Предыдущая ручная инструкция использовала `~/palka-demo/compose.server.yaml` и
`~/palka-demo/private/market.env`. Перед переходом остановите старый launcher и
перенесите **существующие** токены, не генерируя их заново:

```bash
cd ~/palka-demo
docker compose -p palka-demo -f compose.server.yaml down
cd repo
mkdir -p deploy/.state
chmod 700 deploy/.state
test ! -e deploy/.state/market.env && cp ../private/market.env deploy/.state/market.env
chmod 600 deploy/.state/market.env
bash deploy/server.sh up
```

Если целевой файл уже существует, сравните конфигурации локально перед заменой.
Compose project и имя volume сохранены, поэтому используется прежняя база market.
Не запускайте старую и новую конфигурацию одновременно. Root `compose.yaml` и
`infra/compose.yaml` — отдельные режимы, `server.sh` их не запускает.

## Проверки разработки

В checkout разработчика:

```bash
rtk proxy npm run test:deploy
rtk proxy uv run --locked ruff check deploy
rtk proxy uv run --locked ruff format --check deploy
rtk proxy bash -n deploy/server.sh
```

Тесты проверяют сохранение токенов, добавление пользователей, права доступа и отказ
от перезаписи повреждённых credentials, а также совпадение версий серверных
зависимостей с основным приложением. При обновлении зависимостей обновляйте
`deploy/package.json` и его отдельный lockfile вместе с корневым manifest.

17 октября 2026 отдельно проверены ARM64-сборки обоих образов, 23 теста
market/contracts внутри серверного образа и запуск Compose на изолированных
loopback-портах. HTTP smoke проверил public web, read-only proxy, отклонение
неавторизованного доступа и чужого owner ID, а также сохранение синтетической
заявки при пересоздании контейнеров. Это не реальная Bitcoin/RGB-сделка.
Доступ через Oracle firewall, HTTPS/WSS и settlement на разных компьютерах
остаются отдельными проверками. CI также собирает и запускает серверный профиль
на Linux runner; это не проверка внешнего сервера пользователя.
