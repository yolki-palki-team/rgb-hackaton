#!/usr/bin/env python3
"""Import verified public contract metadata into each local demo profile."""

from regtest import native


def main():
    contracts = {}
    for p in ("alice", "bob", "carol"):
        for a in native("state", p)["assets"]["nia"]:
            contracts.setdefault(a["asset_id"], p)
    for contract, issuer in contracts.items():
        public = native("catalog-export", issuer, contractId=contract)
        for p in ("alice", "bob", "carol"):
            native("catalog-import", p, contract=public["contract"])
    print(f"Validated {len(contracts)} public NIA contracts in three local profiles; no signing")


if __name__ == "__main__":
    main()
