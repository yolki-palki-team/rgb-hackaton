#!/usr/bin/env python3
import json

from regtest import ROOT, call, native, rpc


def main():
    lock = json.loads((ROOT / "infra/images.lock.json").read_text())
    for service, data in lock.items():
        info = json.loads(call(["rtk", "proxy", "docker", "image", "inspect", data["image"]]))[0]
        if not any(v.endswith("@" + data["digest"]) for v in info["RepoDigests"]):
            raise RuntimeError(f"unexpected image digest: {service}")
    chain = rpc("getblockchaininfo")
    if chain["chain"] != "regtest":
        raise RuntimeError("wrong network")
    print(
        json.dumps(
            {
                "imagesPinnedAndMatched": True,
                "bitcoinVersion": rpc("getnetworkinfo")["version"],
                "chain": chain["chain"],
                "height": chain["blocks"],
                "sdkHealth": native("health"),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
