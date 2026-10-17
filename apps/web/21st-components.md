# 21st component selection

Reviewed on 2026-10-17 for the palka. public market's black-and-charcoal design.

## Selected by the user

| Component                                                                                     | Placement                 | Integration                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Velorah](https://hirael.com/templates/velorah)                                               | Landing page              | User-supplied template adapted to React/Vite, Prisma background video and poster served locally, centered English palka. copy, glass main CTA and shared navigation. Replaces the sculpture hero. |
| [Halftone Wordmark Footer](https://21st.dev/@kedhareswer/components/halftone-wordmark-footer) | Landing and market footer | Supplied React/Canvas source, palka. wordmark, black palette, real navigation links, reduced-motion support.                                                                                      |

## Recommended next components

These are catalog candidates, not installed implementations. The placement and visual fit are our recommendations.

| Component                                                                                                                      | Where it would help                                                   | Adaptation                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Origin UI — Input with clear button](https://21st.dev/@originui/components/input/input-with-clear-button)                     | Search the order book by symbol or RGB contract ID                    | Keep it permanently visible; use our neutral focus ring and charcoal surface. Clearing restores focus to the field.                                            |
| [Remco — Interactive Empty State](https://21st.dev/@remcostoeten/components/interactive-empty-state)                           | Empty book and no matching orders                                     | Use exchange/route icons and one useful action. Keep network errors distinct. Catalog version adds Framer Motion, so review the dependency before adopting it. |
| [Origin UI — Stepper with titles and descriptions](https://21st.dev/@originui/components/stepper/with-titles-and-descriptions) | Local wallet: draft → validate → publish; separate final signing step | Show actual backend state. Never advance to signed/settled on a timer. Keep this out of the public order book.                                                 |

The 21st CLI metadata/code commands require sign-in in this environment. Public catalog pages and previews were inspected; no hosted AI generation or account changes were used. The hero was adapted from the downloaded Velorah template; the footer uses the source supplied in the conversation. The template's MIT license and original attribution remain in `public/hero/`. No stock photography is needed for the footer.

Component location: `apps/web/src/components/ui`. This is the web workspace's shadcn location, mapped by `@/components/ui`; a second repository-root `components/ui` would duplicate it. Tailwind entry: `src/tailwind.css`; page styles: `src/styles.css`. Existing React, TypeScript and Tailwind setup is sufficient; neither selected component needs a new context provider.

The supplied WalletCard was evaluated but its integration was canceled at the user's request. The local wallet retains its original balance view in the black theme.
