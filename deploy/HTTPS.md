# owlpeer.com: access without SSH tunnels

Website: `https://owlpeer.com/market`. Desktop API: `https://api.owlpeer.com`.
A single Caddy instance accepts HTTP/HTTPS and proxies the site to `web:8080` and
API/WebSocket traffic to `runtime:4100`. Certificates are stored in the persistent
`palka-demo_caddy-data` volume. Market SQLite, legacy credentials, and the Compose
project stay unchanged.

## 1. DNS

In the control panel of the domain's DNS provider, configure:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` (or `owlpeer.com`) | Oracle server's public IPv4 address |
| A | `api` (or `api.owlpeer.com`) | The same public IPv4 address |

Enter only the IP address, without `http://`, a port, or `/market`. Keep NS records
unchanged. Keep the existing root A record if its IP is correct; otherwise update
it. Check for conflicting A/CNAME records and stale AAAA records for both names.
An AAAA record is appropriate only if this server has working, reachable IPv6.
For the first launch with Cloudflare, use DNS only with proxying disabled.

Check from the laptop:

```bash
dig +short A owlpeer.com
dig +short A api.owlpeer.com
dig +short AAAA owlpeer.com
dig +short AAAA api.owlpeer.com
```

Both A queries must return the server IP. Propagation depends on DNS caches and TTL.

## 2. Oracle ports

In Oracle Console, open Networking for the VM: its VNIC's NSG or its subnet's
Security List. Add two stateful ingress rules: Source CIDR `0.0.0.0/0`, protocol
TCP, source ports All, destination port `80` and, separately, `443`.
Keep the SSH rule. `44100` and `44080` remain on loopback; do not expose them.

The OS firewall must also allow these ports. If it blocks HTTPS, an administrator
must run the commands below **in a root session** (the regular beknur user
previously received Authorization failed). No firewall reload is required:

```bash
firewall-cmd --zone=public --add-service=http
firewall-cmd --zone=public --add-service=https
firewall-cmd --zone=public --permanent --add-service=http
firewall-cmd --zone=public --permanent --add-service=https
```

Omitting sudo does not bypass permissions; these commands will not work in an
unprivileged session. Certificate issuance also requires outbound DNS/HTTPS access.

## 3. Enabling HTTPS

After configuring DNS and ports, run on the server:

```bash
cd ~/palka-demo/repo
git pull --ff-only
bash deploy/server.sh https
bash deploy/server.sh status
bash deploy/server.sh logs
```

The command downloads and validates Caddy, saves the mode in
`deploy/.state/https.enabled`, and recreates web on loopback port `44080`, freeing
port `80` for Caddy. A brief website interruption is possible. Other Compose
projects are unaffected. It uses the existing web/market images. For a fresh
installation, run `bash deploy/server.sh up` first.

Wait for certificate issuance, then check:

```bash
bash deploy/server.sh check
```

This checks TLS on the server itself, including hostname and trusted certificate
validation. Separately test public access from the laptop:

```bash
curl -I https://owlpeer.com/market
curl --fail https://api.owlpeer.com/health
```

Expect HTTP 200 and JSON containing `ok: true`. Open `https://owlpeer.com/market`.
HTTP redirects to HTTPS. If a certificate is not ready, inspect `logs`: check both
DNS names, incorrect AAAA records, access to ports 80/443, and any configured CAA
restrictions. Do not disable certificate verification in desktop.

Once enabled, normal `up`, `start`, `status`, `logs`, `check`, and `down` commands
use the HTTPS profile automatically. To update, run `git pull --ff-only`, followed
by `bash deploy/server.sh up`. Do not delete volumes or `.state`.

## 4. Desktop

For a **new** profile, from the repository on the laptop:

```bash
git pull --ff-only
export PALKA_MARKET_URL=https://api.owlpeer.com
export PALKA_PUBLIC_MARKET_URL=https://owlpeer.com/market
npm run dev:desktop
```

URLs and automatically generated ID/token credentials are saved. No SSH tunnel is
required.

For an **existing profile that already connected to this same Oracle database**:
close desktop, save a private backup of `desktop-config.json` with mode 0600, and
change only these fields in the original file:

```json
{
  "marketUrl": "https://api.owlpeer.com",
  "publicMarketUrl": "https://owlpeer.com/market"
}
```

This is an edit fragment, **not a replacement for the entire file**. If the profile
has `marketRegistration: "automatic"`, also set `marketIdentityOrigin` to
`https://api.owlpeer.com`. This explicitly permits sending the original token to
the new HTTPS address of the same database. Do not change ownerId, marketToken,
wallet RPC settings, or state. On macOS the file is usually under
`~/Library/Application Support/palka/`; if using `PALKA_DESKTOP_DATA_DIR`, use the
same directory selected previously. Do not create a new profile just to change
the address. If the profile belonged to a different local market, first transfer
its credentials to the server; that is a separate migration.

Remove old URL overrides in the terminal before launching the saved profile:

```bash
unset PALKA_MARKET_URL PALKA_PUBLIC_MARKET_URL
npm run dev:desktop
```

If using a packaged `.app`, rebuild it after updating the source. Local sidecar
configuration, Bitcoin/RGB infrastructure, and funding remain separate steps;
HTTPS provides direct access to market.

## Checks and limitations

The configuration is checked with `caddy validate`, Compose config, and shell
syntax validation. Public certificate issuance and external access can only be
tested after configuring DNS and ports on Oracle. HTTPS does not add general API
rate limits, backups, or token revocation management; this profile is for a demo.

Official references: [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/https),
[WebSocket proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
and [Oracle security rules](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securityrules.htm).
