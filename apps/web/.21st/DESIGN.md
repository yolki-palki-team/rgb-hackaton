# palka design context

palka is a public BTC/RGB A2A marketplace. The public pages show orders; balances, private policy, QVAC and signing stay in a separate local wallet UI.

- Stack: React 19, TypeScript, Vite, Tailwind v4; shadcn aliases point to `src/components/ui`.
- Palette: black `#080808`, charcoal surfaces `#101010`/`#171717`, text `#eeeeee`, muted `#aaaaaa`, borders `#333333`.
- Landing contains the hero and footer; explanatory sections were removed. The local video loops silently, with pause/play and reduced-motion support.
- User-selected components: Velorah video hero and Halftone Wordmark Footer, both from supplied 21st source.
- All product copy is English. Every navigation link has a real destination.
- Hero video and poster are local. Video and canvas decoration have fallbacks and reduced-motion support.
- Order data is real; loading, empty and error are distinct. No demo orders are presented as live.

See `../21st-components.md` for the catalog shortlist and source links. Machine-readable decisions are in `design.json`.
