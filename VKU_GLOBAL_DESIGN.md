# VKU_GLOBAL_DESIGN.md — VKU AI Challenge Global UI/UX System

Version: 1.0  
Scope: entire frontend

## 1. Authority and purpose

This file is the visual source of truth for VKU AI Challenge. It governs every route, shared component, dialog, and loading/error/empty/locked state.

Order of visual authority:

1. `VKU_GLOBAL_DESIGN.md`
2. `DESIGN.md`
3. `ADMIN_COMPETITIONS_DESIGN.md`
4. `CREATE_COMPETITION_DIALOG_DESIGN.md`
5. `COMPETITION_DETAIL_DESIGN.md`
6. `PARTICIPANT_COMPETITION_DESIGN.md`
7. `ACCOUNT_MANAGEMENT_DESIGN.md`
8. Existing source code

Page-specific documents still define the detailed layout of their pages. If visual guidance conflicts, this document wins. If data or behavior guidance conflicts, the existing source and API contract win.

The goal is one coherent academic technology product: bright, structured, professional, data-oriented, and recognizably VKU. It must not look like a generic SaaS template, gaming dashboard, marketing landing page, or poster.

## 2. Non-negotiable behavior and data rules

UI structure and presentation may change. Business behavior must not.

Do not change:

- Backend behavior, database, schemas, API endpoints, payloads, or response semantics.
- Authentication, authorization, route guards, roles, permissions, or route semantics.
- Competition lifecycle, joining/leaving rules, scoring, submission, quota, account, or member behavior.
- Validation, file constraints, CSV rules, mutation ordering, query behavior, or stale-request protection.
- Markdown parsing, GFM support, sanitization, references, or content visibility.

Do not fabricate competitions, accounts, members, scores, statistics, dates, resources, activity, contact information, imagery, testimonials, slogans, or announcements. All displayed values must continue to come from the current API, state, or approved source modules. About and Support information comes from `frontend/src/lib/vkuInfo.ts`.

## 3. Technical constraints

- Keep the current React + TypeScript architecture.
- Keep one plain global stylesheet; do not add Tailwind, CSS Modules, CSS-in-JS, or another UI framework.
- Use the existing inline-SVG convention with `aria-hidden="true"` and `focusable="false"` for decorative icons.
- Do not add an icon package or a browser-test dependency for this migration.
- Light mode only. Keep `color-scheme: light`; do not add `prefers-color-scheme: dark`.
- Preserve modal portals, focus traps, route focus, skip link, document titles, reduced-motion handling, and focusable table regions.

## 4. Visual identity

- **VKU Blue:** navigation, normal primary actions, information, active states, and system structure.
- **VKU Red:** strong brand accent and destructive actions.
- **VKU Yellow:** highlight, warning, draft, and tertiary brand accent.
- **Green:** semantic success only.
- **Neutral navy/slate:** text, technical surfaces, borders, and inactive controls.

Blue should dominate. Red and yellow create a measured visual rhythm; a component does not need all three colors. Semantic meaning always has priority over decorative rhythm, and status must always be expressed in text as well as color.

Black is not a primary-action color.

## 5. Canonical tokens

The implemented `--vku-*` palette in `frontend/src/index.css` is canonical. Shared semantic aliases must resolve to it rather than maintain a second independent palette.

```css
:root {
  --vku-blue-900: #082b73;
  --vku-blue-800: #073b9a;
  --vku-blue-700: #064fc4;
  --vku-blue-600: #0969e8;
  --vku-blue-500: #1677ff;
  --vku-blue-100: #eaf3ff;
  --vku-blue-50: #f5f9ff;

  --vku-red-800: #b80619;
  --vku-red-700: #d30b23;
  --vku-red-600: #ec1631;
  --vku-red-500: #f3263f;
  --vku-red-100: #ffecef;
  --vku-red-50: #fff6f7;

  --vku-yellow-800: #b45309;
  --vku-yellow-700: #e9a900;
  --vku-yellow-600: #f5b800;
  --vku-yellow-500: #ffc51b;
  --vku-yellow-400: #ffd43b;
  --vku-yellow-100: #fff5cc;
  --vku-yellow-50: #fffbeb;

  --vku-ink: #0b1f44;
  --vku-ink-muted: #526078;
  --vku-border: #e5e7eb;
  --vku-border-soft: #eef1f5;
}
```

Semantic aliases must distinguish text color from typography size. Never overload one custom property with both meanings. Dark code/technical surfaces use a dedicated ink token and must not depend on the primary-action token.

## 6. Foundations

### Typography

Use the self-hosted Inter family for UI and JetBrains Mono for IDs, filenames, slugs, paths, scores, and code-like data.

- Page title: 32–40px, 700–800.
- Major section: 22–26px, 700.
- Card title: 17–20px, 650–700.
- Body/table: 14–15px.
- Secondary/label: 12–14px, 600–700 where appropriate.

Prefer weights 400, 500, 600, and 700. Reserve heavier weight for major titles or prominent numeric summaries.

### Spacing and sizing

Prefer the existing spacing scale based on 4, 8, 12, 16, 20, 24, 32, 40, 48, and 64px.

- Normal section gap: 24px.
- Large section gap: 32px.
- Card padding: 20–24px; 16–20px on small screens.
- Normal controls: 40–42px high.
- Primary CTA/input: 44–46px high.
- Important touch targets: at least 44px when layout permits.

### Surfaces

- Page background: very light neutral/blue gradient.
- Cards: white, subtle border, 12–14px radius, restrained shadow.
- Large panels/dialogs: 14–16px radius.
- Inputs/buttons: 8–10px radius.
- Pills: full radius.
- Never use heavy black borders or floating shadows.

### Motion

Use only restrained 150–220ms transitions for color, border, shadow, and subtle translation. Respect `prefers-reduced-motion`. Do not add parallax, particles, bouncing, animated gradients, or complex page transitions.

## 7. Shared component rules

### Header and navigation

Use a white global header with subtle bottom border. Active navigation is blue with a light-blue surface and visible active indicator. The existing mobile drawer behavior, inert background, focus trap, Escape handling, and focus restoration are immutable.

### Page headers

Major pages use a clear title/subtitle hierarchy and may use the established light-blue surface, diagonal brand geometry, or one restrained blue/red/yellow accent strip. Do not repeat all brand decorations on every card.

### Buttons

- Primary: VKU Blue background, white text, blue border.
- Secondary: white background, navy text, neutral border.
- Danger: pale red background, red text/border; solid red only where emphasis is warranted.
- Warning: pale yellow background with contrast-safe amber text.
- Disabled: visibly muted while preserving the existing native or ARIA-disabled behavior.

Every button keeps an obvious `:focus-visible` ring. Normal create/update/reset actions are blue, not red.

### Forms

Inputs, selects, and textareas share a white surface, neutral border, 8–9px radius, and blue focus border/ring. Required marks and validation are red; help text is muted. Do not change labels, order, IDs, autocomplete, validation, or submitted values.

### Cards and toolbars

Cards use white surfaces, subtle borders/shadows, and clear internal hierarchy. A 3px blue/red/yellow top border may organize sections decoratively. Search/filter/action toolbars use the same card system and wrap cleanly at narrow widths.

### Badges and states

Badges always contain text. Use:

- Blue for information/admin/current selection.
- Green for success/active/completed.
- Red for errors/destructive states.
- Yellow for warning/draft/restricted states.
- Neutral for inactive/ended/supporting metadata.

### Tables and pagination

Data tables use white card containers, a subtle header background, semantic column headings, calm row separators, and a soft hover state. Never hide required columns solely to fit mobile. Wide tables scroll inside a named, keyboard-focusable region and must not create body overflow. Pagination remains outside the horizontal scrolling region when the current page already follows that pattern.

### Dialogs

Continue using the shared portaled modal. Root/shared tokens must therefore provide the normal VKU Blue action color. Page variants may refine layout; danger confirmation remains red. Keep focus trap, Escape, backdrop behavior, and focus restoration unchanged.

### Loading, error, empty, and locked states

- Use skeletons for content loading where already available; a centered branded spinner is acceptable for initial auth/application bootstrap.
- Error surfaces remain red and must not swallow errors.
- Empty states are concise, factual, and may include only a valid existing action.
- Locked states explain the actual existing condition and use blue structure with restrained red/yellow accents.
- Do not fake delay or placeholder data.

## 8. Page archetypes

- **Listing:** page header, optional real aggregate cards, toolbar, grid/table, optional pagination.
- **Detail:** identity/status/actions, facts, tabs/navigation, content.
- **Form/workspace:** page header, grouped sections, clear constraints, action area, result state.
- **Authentication:** focused light branded background, VKU identity, centered card, blue primary CTA, no dashboard header when the existing route omits it.
- **System/error:** minimal composition, VKU Blue dominant, clear recovery action.

## 9. Established page patterns to preserve

- Public competition cards rotate blue/red/yellow by rendered grid index, never by business status.
- Admin competition rows rotate decorative blue/red/yellow accents by rendered row index.
- Dashboard and admin competition list/alias use the 1440px shell. Other pages retain the existing 1280px shell unless a page-specific document says otherwise.
- Admin competition detail and account management are established VKU baselines; shared-token changes must not regress their behavior or layouts.
- The participant competition module (`/competitions/:slug` and its four child routes) keeps the default shell and confines all four tabs to one `68rem` frame via `.comp-page`. Its 7-column tables scroll inside their own named regions rather than widening the page. Its masthead reuses the `.ac-page-head` surface recipe from the admin competitions page. See `PARTICIPANT_COMPETITION_DESIGN.md`.
- Participant detail keeps its nested routing, sticky content navigation, content order, resources, join controls, and outlet context.
- About and Support keep only sourced content from `frontend/src/lib/vkuInfo.ts`.

## 10. Responsive and accessibility requirements

Verify at 375, 640, 768, 1024, 1200, and 1440px.

- No horizontal body overflow.
- Cards and forms reflow without clipping; only designated table/content regions scroll horizontally.
- Long names, titles, emails, IDs, and filenames wrap or truncate intentionally.
- Header, sticky elements, and dialogs do not obscure focused controls.
- Touch targets, tab order, accessible names, roles, live regions, and heading hierarchy remain valid.
- Preserve visible focus rings, skip navigation, route focus, modal/drawer focus traps, and focus restoration.
- Color is never the sole carrier of information; yellow text must remain contrast-safe.

## 11. Acceptance criteria

- Every frontend route and nested state follows this system.
- Normal primary CTA and active interaction colors are VKU Blue, never black.
- Destructive actions are red, warnings yellow, and green is semantic success only.
- Existing API/data/business behavior is unchanged.
- No fabricated data or content is introduced.
- Unsupported Tailwind-like utility classes and migrated hardcoded presentation colors are removed.
- Tests, lint, TypeScript, and production build pass.
- Browser checks cover public, participant, admin, loading, error, empty, populated, blocked, locked, and dialog states at the required widths.
