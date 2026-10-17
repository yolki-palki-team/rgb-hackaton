# palka wallet UI kit

The wallet uses the public site's black background, Georgia serif wordmark and display headings, and DM Sans/sans-serif body stack. Fonts use local fallbacks; no remote font requests are needed. The brand is `palka`, without a trailing dot.

Reusable React components live in `src/components/ui/wallet-kit.tsx`: Sidebar, Button, Panel, StatusBadge, AssetCard, DataTable, Input, Select, Textarea, SectionTitle, AssetIcon, and Icon. They forward native HTML attributes and events. Wallet state and actions remain in App and LocalClient. Color and typography tokens live in `src/ui-kit.css`; existing wallet layout rules remain in `src/styles.css`. Tailwind v4 utilities and shadcn aliases are configured for future additions without adding packages.

## Selected 21st references

| Reference | Use in palka |
| --- | --- |
| [Dashboard with Collapsible Sidebar](https://21st.dev/@uniquesonu/components/dashboard-with-collapsible-sidebar) | Compact navigation, active selection, separate content area. The existing three-view navigation stays visible. |
| [Origin UI Table](https://21st.dev/@originui/components/table/table-with-vertical-lines) | Restrained table header, aligned amounts, thin dividers. Native table semantics are retained. |
| [System Status Block](https://21st.dev/@preetsuthar17/components/system-status-block) | Compact treatment of wallet and model availability, always driven by actual client state. |
| [Empty State](https://21st.dev/@uniquesonu/components/empty-state-beautiful-accessible-no-data-states) | Clear unavailable and empty states with the existing pairing action. |

These are design references inspected on public 21st catalog pages, not imported registry implementations. The CLI requires authentication in this environment. The kit is extracted and adapted from this project's components. The crypto dashboard was considered but its remote price feed and portfolio analytics are outside this wallet's current scope.

## Preserved boundaries

- No sample balances unless the user explicitly enables preview.
- Exact amount strings and network state come from the local client.
- Draft validation, publication and signing remain separate actions.
- No cloud inference, remote price calls, or credentials in the kit.
- Disabled controls, accessible labels and reduced-motion preferences remain supported.
