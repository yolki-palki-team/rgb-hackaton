# Project instructions

- Read `README.md` and `materials.md` before making changes.
- Support both direct two-party swaps and three-party atomic ring swaps. Sequential transfers are not an atomic swap.
- Run QVAC locally. Keep keys and private policies local; use deterministic code for amounts, matching and signing checks.
- Require user approval before signing. Never commit secrets or wallet state.
- Keep mocks visibly separate from real RGB settlement; verify SDK capabilities before relying on them.
- Coordinate shared interfaces and file ownership with other developers. Preserve their changes.
- Run checks relevant to the change and document remaining limitations.
- Preserve Git history during the hackathon: no rebase, amend or force-push.
- Prefix shell commands with `rtk`; use `rtk proxy <command>` when needed.
