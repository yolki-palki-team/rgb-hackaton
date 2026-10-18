"""Explicit development chain selection and authenticated Mutinynet RPC."""

import argparse
import base64
import http.client
import json
import os
import stat
from pathlib import Path
from urllib.parse import urlsplit

MUTINYNET_CHALLENGE = "512102f7561d208dd9ae99bf497273e16f389bdbd6c4742ddb8e6b216e64fa2928ad8f51ae"
MUTINYNET_CHECKPOINT = "000002855893a0a9b24eaffc5efc770558a326fee4fc10c9da22fc19cd2954f9"
LIMIT = 8 * 1024 * 1024
RPC_METHODS = {
    "getblockchaininfo",
    "getblockhash",
    "getblockcount",
    "getnetworkinfo",
    "getindexinfo",
    "gettxout",
    "getrawtransaction",
    "combinepsbt",
    "finalizepsbt",
    "decoderawtransaction",
    "testmempoolaccept",
    "sendrawtransaction",
}


def network():
    selected = os.environ.get("PALKA_NETWORK", "regtest")
    if selected == "regtest":
        return "regtest"
    if selected in ("mutinynet", "signetcustom"):
        return "signetcustom"
    raise ValueError("PALKA_NETWORK must be regtest or mutinynet (signetcustom)")


def profile_name():
    return "mutinynet" if network() == "signetcustom" else "regtest"


def native_context():
    context = {"network": network()}
    if context["network"] == "signetcustom":
        context["signetChallenge"] = MUTINYNET_CHALLENGE
    return context


def configuration():
    if os.environ.get("PALKA_CHAIN_CONFIG"):
        raise ValueError("The shared regtest invitation cannot be used with Mutinynet")
    filename = os.environ.get("PALKA_MUTINYNET_CONFIG")
    if not filename:
        raise ValueError(
            "Set PALKA_MUTINYNET_CONFIG to a private endpoint file; see deploy/MUTINYNET.md"
        )
    path = Path(filename).expanduser()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("Mutinynet endpoint configuration must be a private regular file")
    config = json.loads(path.read_text())
    required = (
        "bitcoinRpcUrl",
        "bitcoinRpcUser",
        "bitcoinRpcPassword",
        "indexerUrl",
        "rgbProxyUrl",
    )
    if not isinstance(config, dict) or any(
        not isinstance(config.get(k), str) or not config[k] for k in required
    ):
        raise ValueError(
            "Mutinynet requires explicit Core RPC credentials, RGB indexer and RGB proxy"
        )
    for key in ("bitcoinRpcUrl", "rgbProxyUrl"):
        url = urlsplit(config[key])
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or (url.scheme == "http" and url.hostname not in ("127.0.0.1", "localhost", "::1"))
        ):
            raise ValueError(f"{key} must use HTTPS or loopback HTTP without embedded credentials")
    if ":" in config["bitcoinRpcUser"]:
        raise ValueError("Invalid Core RPC username")
    return config


def native_environment(config=None):
    if network() == "regtest":
        return {}
    config = configuration() if config is None else config
    return {"RGB_INDEXER_URL": config["indexerUrl"], "RGB_PROXY_URL": config["rgbProxyUrl"]}


def _rpc(config, method, params):
    url = urlsplit(config["bitcoinRpcUrl"])
    connection_type = (
        http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_type(url.hostname, url.port, timeout=30)
    credentials = base64.b64encode(
        (config["bitcoinRpcUser"] + ":" + config["bitcoinRpcPassword"]).encode()
    ).decode()
    try:
        connection.request(
            "POST",
            url.path or "/",
            json.dumps({"jsonrpc": "2.0", "id": "palka", "method": method, "params": params}),
            {"Authorization": "Basic " + credentials, "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        body = response.read(LIMIT + 1)
        if response.status != 200 or len(body) > LIMIT:
            raise RuntimeError(
                f"Mutinynet Core RPC failed ({response.status}); request was not retried"
            )
        result = json.loads(body)
        if (
            not isinstance(result, dict)
            or result.get("id") != "palka"
            or result.get("error")
            or "result" not in result
        ):
            raise RuntimeError(f"Mutinynet Core RPC {method} failed; request was not retried")
        return result["result"]
    except (OSError, http.client.HTTPException, json.JSONDecodeError) as error:
        raise RuntimeError(
            "Mutinynet Core RPC unavailable or response uncertain; request was not retried"
        ) from error
    finally:
        connection.close()


def check_chain(config=None, *, allow_syncing=False):
    config = configuration() if config is None else config
    info = _rpc(config, "getblockchaininfo", [])
    if (
        not isinstance(info, dict)
        or info.get("chain") != "signet"
        or info.get("signet_challenge") != MUTINYNET_CHALLENGE
    ):
        raise ValueError("Core must report the pinned Mutinynet custom Signet challenge")
    if not isinstance(info.get("initialblockdownload"), bool):
        raise ValueError("Core did not report its synchronization state")
    if info.get("initialblockdownload") is not False and not allow_syncing:
        raise ValueError("Mutinynet Core has not completed initial synchronization")
    if _rpc(config, "getblockhash", [1]) != MUTINYNET_CHECKPOINT:
        raise ValueError("Mutinynet Core checkpoint mismatch")
    return info


def rpc(method, *params):
    if method not in RPC_METHODS:
        raise ValueError(
            "RPC method is unavailable on Mutinynet; use its faucet for funding, never regtest mining"
        )
    config = configuration()
    check_chain(config)
    return _rpc(config, method, list(params))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-syncing",
        action="store_true",
        help="Allow receive-only desktop startup while verified Core is synchronizing",
    )
    args = parser.parse_args()
    if network() != "signetcustom":
        raise ValueError("Select PALKA_NETWORK=mutinynet for this read-only preflight")
    from regtest import native

    config = configuration()
    info = check_chain(config, allow_syncing=args.allow_syncing)
    indexes = _rpc(config, "getindexinfo", [])
    if not isinstance(indexes, dict) or not isinstance(indexes.get("txindex"), dict):
        raise ValueError("Mutinynet Core requires txindex=1")
    index_synced = indexes["txindex"].get("synced") is True
    if not index_synced and not args.allow_syncing:
        raise ValueError("Mutinynet Core requires a fully synchronized txindex")
    health = native("health")
    if health.get("network") != "signetcustom":
        raise ValueError("Rebuild the native wallet with Mutinynet support")
    print(
        json.dumps(
            {
                "profile": "mutinynet",
                "network": "signetcustom",
                "height": info["blocks"],
                "headers": info.get("headers"),
                "initialBlockDownload": info["initialblockdownload"],
                "txindexSynced": index_synced,
                "ready": info["initialblockdownload"] is False and index_synced,
                "checkpoint": MUTINYNET_CHECKPOINT,
                "sdkHealth": health,
                "funded": False,
                "settlementVerified": False,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
