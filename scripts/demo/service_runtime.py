"""Launch the real A services and B sidecars; all credentials stay in ignored state."""

import json
import os
import secrets
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from regtest import ROOT, STATE

sys.path.insert(0, str(ROOT / "packages/wallet"))
from protocol import read, save

CONFIG = STATE / "services/config.json"
ORIGIN = "http://127.0.0.1:5173"
PEOPLE = ("alice", "bob", "carol")


def configure(source, base_port=43100):
    source = Path(source).resolve()
    for name in (
        "apps/market/src/main.ts",
        "apps/local-client/src/main.ts",
        "node_modules/tsx/dist/cli.mjs",
        "node_modules/node/bin/node",
    ):
        if not (source / name).is_file():
            raise ValueError(f"Missing real service source/dependency: {name}")
    if CONFIG.exists():
        config = read(CONFIG)
        if config["source"] != str(source) or config["basePort"] != base_port:
            raise ValueError(
                "Existing profile config is immutable; use its source/ports or a separate state directory"
            )
        return config
    if not 1024 <= base_port <= 65520:
        raise ValueError("Invalid base port")
    config = {
        "source": str(source),
        "basePort": base_port,
        "origin": ORIGIN,
        "profiles": {
            p: {
                "marketToken": secrets.token_hex(32),
                "localToken": secrets.token_hex(32),
                "walletToken": secrets.token_hex(32),
                "localPort": base_port + i + 1,
                "walletPort": base_port + i + 11,
            }
            for i, p in enumerate(PEOPLE)
        },
    }
    provenance = source / ".integration-source.json"
    if provenance.exists():
        config["sourceRevision"] = read(provenance)["gitRevision"]
    save(CONFIG, config)
    return config


def request(url, token, body=None, origin=None):
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    if origin:
        headers["Origin"] = origin
    req = urllib.request.Request(url, None if body is None else json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        payload = json.load(error)
        raise RuntimeError(f"HTTP {error.code}: {payload}") from None


class Runtime:
    def __init__(self):
        self.config = read(CONFIG)
        self.source = Path(os.environ.get("RGB_SERVICE_SOURCE", self.config["source"]))
        if os.environ.get("RGB_SERVICE_SOURCE"):
            self.config["baseSourceRevision"] = self.config.pop("sourceRevision", None)
        self.children = {}

    def local(self, person, path, body=None):
        cfg = self.config["profiles"][person]
        return request(
            f"http://127.0.0.1:{cfg['localPort']}/api{path}",
            cfg["localToken"],
            body,
            f"http://127.0.0.1:{cfg['localPort']}",
        )

    def wallet(self, person, method, params=None):
        cfg = self.config["profiles"][person]
        result = request(
            f"http://127.0.0.1:{cfg['walletPort']}/rpc",
            cfg["walletToken"],
            {
                "protocolVersion": 1,
                "requestId": str(uuid.uuid4()),
                "method": method,
                "params": params or {},
            },
        )
        if "error" in result:
            raise RuntimeError(result["error"]["code"])
        return result["result"]

    def spawn(self, name, args, env):
        if name in self.children:
            raise ValueError("Already running")
        log = STATE / "services" / (name + ".log")
        with log.open("ab") as output:
            os.chmod(log, 0o600)
            self.children[name] = subprocess.Popen(
                ["rtk", "proxy", *args],
                cwd=self.source,
                env={**os.environ, "RGB_DEMO_STATE": str(STATE), **env},
                stdout=output,
                stderr=output,
                start_new_session=True,
            )

    def node(self, entry):
        return [
            str(self.source / "node_modules/node/bin/node"),
            str(self.source / "node_modules/tsx/dist/cli.mjs"),
            str(self.source / entry),
        ]

    def market(self):
        self.spawn(
            "market",
            self.node("apps/market/src/main.ts"),
            {
                "MARKET_PORT": str(self.config["basePort"]),
                "MARKET_DB_PATH": str(STATE / "services/market.sqlite"),
                "MARKET_TOKENS_JSON": json.dumps(
                    {c["marketToken"]: p for p, c in self.config["profiles"].items()}
                ),
            },
        )

    def profile(self, person, fault=None):
        # Startup deliberately cannot initialize keys, fund, issue, or recreate chain state.
        if not (STATE / person / "keys.json").is_file():
            raise ValueError("Run separate regtest setup/catalog first")
        cfg = self.config["profiles"][person]
        env = {"WALLET_RPC_TOKEN": cfg["walletToken"]}
        entry = ROOT / "packages/wallet/server.py"
        if fault:
            entry = ROOT / "scripts/demo/service_fault_sidecar.py"
            env["RGB_TEST_FAULT"] = fault
        self.spawn(
            "wallet-" + person,
            [
                sys.executable,
                str(entry),
                "--profile",
                person,
                "--owner",
                person,
                "--port",
                str(cfg["walletPort"]),
            ],
            env,
        )
        self.start_local(person)

    def start_local(self, person):
        cfg = self.config["profiles"][person]
        self.spawn(
            "local-" + person,
            self.node("apps/local-client/src/main.ts"),
            {
                "LOCAL_OWNER_ID": person,
                "LOCAL_PORT": str(cfg["localPort"]),
                "LOCAL_HOST": "127.0.0.1",
                "LOCAL_STATE_DIR": str(STATE / "services" / person),
                "LOCAL_SESSION_TOKEN": cfg["localToken"],
                "LOCAL_ALLOWED_ORIGINS": f"http://127.0.0.1:{cfg['localPort']}",
                "MARKET_URL": f"http://127.0.0.1:{self.config['basePort']}",
                "MARKET_TOKEN": cfg["marketToken"],
                "WALLET_MODE": "real",
                "WALLET_RPC_TOKEN": cfg["walletToken"],
                "WALLET_RPC_URL": f"http://127.0.0.1:{cfg['walletPort']}",
                "QVAC_DEVICE": "cpu",
            },
        )

    def ready(self, people=PEOPLE, wallet_state=True):
        for person in people:
            last = "starting"
            for _ in range(120):
                if any(p.poll() is not None for p in self.children.values()):
                    raise RuntimeError("Service exited; inspect private services/*.log")
                try:
                    if not wallet_state:
                        # During broadcast recovery RGB SQL can lag a spent mempool
                        # input. The sync API must remain reachable without state().
                        self.local(person, "/snapshot")
                        break
                    state = self.local(person, "/state")
                    if state["mode"] == "real" and state["ownerId"] == person:
                        self.local(person, "/snapshot")
                        break
                except (OSError, RuntimeError) as error:
                    last = str(error)
                time.sleep(0.5)
            else:
                raise RuntimeError(f"Services not ready ({person}): {last}")

    def stop(self, name):
        child = self.children.pop(name, None)
        if child is None:
            return
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()

    def close(self):
        for name in list(reversed(self.children)):
            self.stop(name)
