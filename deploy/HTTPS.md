# owlpeer.com: подключение без SSH-туннелей

Сайт: `https://owlpeer.com/market`. Desktop API: `https://api.owlpeer.com`.
Один Caddy принимает HTTP/HTTPS и проксирует сайт в `web:8080`, API и WebSocket
в `runtime:4100`. Certificate storage — постоянный volume `palka-demo_caddy-data`.
Market SQLite, legacy credentials и Compose project остаются прежними.

## 1. DNS

В панели провайдера, обслуживающего DNS домена, настройте:

| Тип | Имя | Значение |
| --- | --- | --- |
| A | `@` (или `owlpeer.com`) | публичный IPv4 Oracle-сервера |
| A | `api` (или `api.owlpeer.com`) | тот же публичный IPv4 |

Значение — только IP, без `http://`, порта и `/market`. NS-записи не меняйте.
Существующую A-запись корня оставьте, если IP уже правильный; иначе измените её.
Проверьте отсутствие конфликтующих A/CNAME и старых AAAA для этих двух имён.
AAAA нужна только при настроенном доступном IPv6 этого сервера.
Для первого запуска через Cloudflare используйте DNS only, без proxy.

На ноутбуке проверьте:

```bash
dig +short A owlpeer.com
dig +short A api.owlpeer.com
dig +short AAAA owlpeer.com
dig +short AAAA api.owlpeer.com
```

Обе A должны вернуть IP сервера. Обновление зависит от DNS-кеша/TTL.

## 2. Порты Oracle

В Oracle Console откройте Networking для своей VM: NSG её VNIC или Security List
её subnet. Добавьте две stateful ingress rules: Source CIDR `0.0.0.0/0`, protocol
TCP, source ports All, destination port `80` и отдельно `443`.
Не удаляйте SSH-правило. `44100` и `44080` остаются loopback; не открывайте их.

OS firewall также должен пропускать эти порты. Если он блокирует HTTPS, команды
ниже выполняет администратор **в root-сессии** (обычный beknur ранее получил
Authorization failed). Они не требуют перезагрузки firewall:

```bash
firewall-cmd --zone=public --add-service=http
firewall-cmd --zone=public --add-service=https
firewall-cmd --zone=public --permanent --add-service=http
firewall-cmd --zone=public --permanent --add-service=https
```

Не запускайте их в непривилегированной сессии в ожидании, что отсутствие sudo
обойдёт права. Для сертификатов серверу также нужен исходящий DNS/HTTPS.

## 3. Включение HTTPS

После настройки DNS/портов, на сервере:

```bash
cd ~/palka-demo/repo
git pull --ff-only
bash deploy/server.sh https
bash deploy/server.sh status
bash deploy/server.sh logs
```

Команда загружает и проверяет Caddy, сохраняет режим в `deploy/.state/https.enabled`
и пересоздаёт web с loopback-портом `44080`, освобождая `80` для Caddy. Возможен
короткий перерыв доступа к сайту. Другие Compose projects не затрагиваются.
Она использует уже собранные web/market-образы. Для первого запуска с нуля сначала
выполните `bash deploy/server.sh up`.

Дождитесь выдачи сертификатов и проверьте:

```bash
bash deploy/server.sh check
```

Этот check проверяет TLS на самом сервере, включая hostname и доверенный сертификат.
Из ноутбука отдельно проверьте публичный маршрут:

```bash
curl -I https://owlpeer.com/market
curl --fail https://api.owlpeer.com/health
```

Ожидается HTTP 200 и JSON с `ok: true`. Откройте `https://owlpeer.com/market`.
HTTP перенаправляется на HTTPS. Если сертификата ещё нет, смотрите `logs`:
проверяйте оба DNS-имени, ошибочные AAAA, доступ 80/443 и ограничения CAA, если они
заданы. Не отключайте проверку сертификатов в desktop.

После включения обычные `up`, `start`, `status`, `logs`, `check`, `down` автоматически
используют HTTPS-профиль. Обновление: `git pull --ff-only`, затем
`bash deploy/server.sh up`. Не удаляйте volumes или `.state`.

## 4. Desktop

Для **нового** профиля, из репозитория на ноутбуке:

```bash
git pull --ff-only
export PALKA_MARKET_URL=https://api.owlpeer.com
export PALKA_PUBLIC_MARKET_URL=https://owlpeer.com/market
npm run dev:desktop
```

URL и автоматически созданные ID/token сохранятся. SSH-туннель не нужен.

Для **существующего профиля, который уже подключался к этой же Oracle-базе**:
закройте desktop, сохраните приватную резервную копию `desktop-config.json` с
правами 0600 и измените только эти поля в исходном файле:

```json
{
  "marketUrl": "https://api.owlpeer.com",
  "publicMarketUrl": "https://owlpeer.com/market"
}
```

Это фрагмент изменений, **не замена всего файла**. Если профиль имеет
`marketRegistration: "automatic"`, также замените `marketIdentityOrigin` на
`https://api.owlpeer.com`. Это явное разрешение отправлять прежний токен через
новый HTTPS-адрес той же базы. Не меняйте ownerId, marketToken, wallet RPC или state.
Обычно файл на macOS находится в `~/Library/Application Support/palka/`; при
`PALKA_DESKTOP_DATA_DIR` используйте именно ранее выбранный каталог. Не создавайте
новый профиль ради смены адреса. Если прежний профиль был от другого локального
market, сначала перенесите его credentials на сервер; это отдельная миграция.

В терминале уберите старые URL overrides перед запуском сохранённого профиля:

```bash
unset PALKA_MARKET_URL PALKA_PUBLIC_MARKET_URL
npm run dev:desktop
```

Если используете готовый `.app`, пересоберите его после обновления исходников.
Настройка локального sidecar, Bitcoin/RGB-инфраструктуры и пополнение остаются
отдельными шагами; HTTPS даёт прямой доступ к market.

## Проверки и границы

Конфигурация проверяется `caddy validate`, Compose config и shell syntax check.
Выдача публичного сертификата и внешний доступ проверяются только после настройки
DNS/портов на Oracle. HTTPS не добавляет общие API rate limits, backup или управление
отзывом токенов; текущий профиль предназначен для демки.

Официальные источники: [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/https),
[WebSocket proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[Oracle security rules](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securityrules.htm).
