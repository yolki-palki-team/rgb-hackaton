# RGB P2P Exchange

A non-custodial P2P marketplace for BTC and RGB assets, supporting direct swaps between two users and atomic ring swaps between three users.

Users describe their goals in plain language. An on-device QVAC assistant turns those goals and private preferences into orders for users to review. A deterministic matching engine finds compatible orders; each wallet validates the proposed exchange and requests approval before signing a shared Bitcoin transaction.

## MVP

- Direct and three-party swaps on Bitcoin regtest, using BTC and two test RGB assets.
- Local AI inference, private keys and wallet state stay on the user's device.
- Fixed order amounts, full execution and explicit approval before signing.
- Web interface, matching server and local wallet client.

**Status:** concept and development planning. Atomic settlement and end-to-end integration remain to be implemented and verified.

Hackathon resources and stack guidance are in [materials.md](materials.md).
