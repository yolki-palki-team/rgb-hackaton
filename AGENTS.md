# Project instructions

- Read `README.md` and `materials.md` before making changes.
- Support both direct two-party swaps and three-party atomic ring swaps. Sequential transfers are not an atomic swap.
- Run QVAC locally. Keep keys and private policies local; use deterministic code for amounts, matching and signing checks.
- Require user approval before mainnet signing. Development transfers on regtest, testnet, signet and signetcustom are authorized without repeated user confirmation; still validate amounts, recipients, fees and immutable signing intent. Never commit secrets or wallet state.
- Keep mocks visibly separate from real RGB settlement; verify SDK capabilities before relying on them.
- Coordinate shared interfaces and file ownership with other developers. Preserve their changes.
- Run checks relevant to the change and document remaining limitations.
- Preserve Git history during the hackathon: no rebase, amend or force-push.
- Prefix shell commands with `rtk`; use `rtk proxy <command>` when needed.
- Follow the repository code style: `rtk proxy npm run format` applies Prettier, Ruff and rustfmt; `rtk proxy npm run lint` runs ESLint, Stylelint, Ruff and Clippy. Before handing off changes, run the relevant checks (or `rtk proxy npm run check` for the full suite). Use `uv run --locked` for Python tools, keep dependency lockfiles current, and exclude generated SDK code and private wallet state from formatting.
