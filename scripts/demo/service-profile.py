#!/usr/bin/env python3
"""Persistent host profile launcher. Funding/issuance and shared infrastructure are separate."""

import argparse
import json
import signal
import time

from service_runtime import CONFIG, PEOPLE, Runtime, configure

parser = argparse.ArgumentParser()
parser.add_argument("command", choices=["configure", "market", "run", "up", "health"])
parser.add_argument("--source")
parser.add_argument("--base-port", type=int, default=43100)
parser.add_argument("--profile", choices=PEOPLE, default="alice")
parser.add_argument(
    "--desktop",
    choices=PEOPLE,
    help="Use Electron for this profile instead of its browser client (up only)",
)
args = parser.parse_args()
if args.desktop and args.command != "up":
    parser.error("--desktop requires up")
if args.command == "configure":
    if not args.source:
        parser.error("--source is required")
    configure(args.source, args.base_port)
    print(
        json.dumps({"privateConfig": str(CONFIG), "walletMode": "real", "fundingOrIssuance": False})
    )
else:
    runtime = Runtime()
    if args.command == "health":
        print(json.dumps(runtime.local(args.profile, "/health"), indent=2))
    else:
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        try:
            if args.command == "market":
                runtime.market()
            elif args.command == "up":
                runtime.market()
                for person in PEOPLE:
                    runtime.profile(person, desktop=args.desktop == person)
                    if args.desktop != person:
                        print(
                            json.dumps({"profile": person, "pairingFile": runtime.pairing(person)}),
                            flush=True,
                        )
                runtime.ready([p for p in PEOPLE if p != args.desktop], wallet_state=False)
                runtime.web()
            else:
                runtime.profile(args.profile)
                runtime.ready([args.profile], wallet_state=False)
                print(json.dumps({"pairingFile": runtime.pairing(args.profile)}), flush=True)
            print(
                json.dumps(
                    {"running": args.command, "profile": args.profile, "privateConfig": str(CONFIG)}
                ),
                flush=True,
            )
            while True:
                if any(child.poll() is not None for child in runtime.children.values()):
                    raise RuntimeError("Service exited; inspect private logs")
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            runtime.close()
