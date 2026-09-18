# PARTICIPANT_COMPETITION_DESIGN.md - VKU AI Challenge Participant Competition Module

Version: 1.0
Scope: `/competitions/:slug` and its four child routes
Frontend: React + TypeScript, one global stylesheet

## 1. Purpose and authority

This document is the detailed layout contract for the **participant competition module**. It inherits `VKU_GLOBAL_DESIGN.md` and never overrides it.

Authority order for this module:

1. `VKU_GLOBAL_DESIGN.md` - foundations, tokens, shared components.
2. This document - module layout, shell, workspace, and Markdown presentation.
3. Existing source code and API contract - data, behavior, and state.

If visual guidance conflicts, `VKU_GLOBAL_DESIGN.md` wins. If data or behavior guidance conflicts, the existing implementation wins.

## 2. Module shape

This is **one module with four tabs**, not four pages.

| Route | Workspace |
|---|---|
| `/competitions/:slug` | Tổng quan (overview + `content/:contentSlug`) |
| `/competitions/:slug/submit` | Nộp bài |
| `/competitions/:slug/submissions` | Bài đã nộp |
| `/competitions/:slug/leaderboard` | Bảng xếp hạng |

`CompetitionDetailPage` is the only shell. It owns the breadcrumb, masthead, facts, tab navigation, and the optional content sidebar, and renders the active workspace through a React Router `Outlet` with the existing `CompetitionContext`. There is no second router, layout, or data provider, and the competition header is never duplicated inside a workspace.

The masthead and the tab bar render identically on all four routes. Switching tabs must not move or resize shared chrome.

## 3. Non-negotiable behavior and data rules

This module is UI-only. The following must not change:

- API endpoints, payloads, response semantics, backend, or database.
- Route URLs, `RequireAuth` placement, route guards, roles, and permissions.
- Competition lifecycle, status/time gates, join/leave and invite-code behavior.
- Submission eligibility, quota, accepted file types, upload limits, and CSV validation.
- CSV schema, scoring metrics, score calculation, ranking, and tie-break.
- Submission history, pagination page sizes, content visibility, and leaderboard visibility.
- Markdown source files, parser pipeline, sanitizer schema, and asset policy.

No fabricated competition data, score, quota, ranking, activity, or live state may be rendered. Every displayed value comes from the API, component state, or an approved source module.

## 4. Width contract

The whole module lives inside one frame: `.comp-page` capped at `68rem` (1088px) and centered, matching `.dash-page`. The default `.app-main` shell applies - `App.tsx` does **not** give `/competitions/*` a wide-shell class.

| Layer | Width | Applied by |
|---|---|---|
| Breadcrumb, masthead, tab bar, content grid | `68rem` (1088px), centered | `.comp-page` |
| Overview / content grid (sidebar + article) | same frame | `.content-layout` |
| Nộp bài / Bài đã nộp / Bảng xếp hạng | same frame, inside the shared `.comp-body` card | `.content-layout.is-workspace` |

All four routes share exactly one frame width, so switching tabs never moves the outer edge. This is deliberate: the module originally rendered this way, and widening it pushed child-page text past the frame's left and right margins.

Wide content does not widen the frame. The 7-column tables and long code/Markdown lines scroll **inside** their own named regions (`.subm-table-wrap`, `.lb-table-wrap`, `.md-table-wrap`), never by growing the page.

The frame change must not leak to `/`, `/admin/*`, `/gioi-thieu`, `/ho-tro`, or the 404 route; those keep their own established shells.

## 5. Shell composition

- **Breadcrumb** - a single back link to the competition list. Not a live region.
- **Masthead** - 3px VKU Blue top border over the same surface recipe as `.ac-page-head` on the admin competitions page: a 135° white → `--vku-blue-50` gradient, plus an `::before` diagonal ribbon of light blue/red/yellow in the top-right corner. The two pages are siblings in one system, so their page-head panels share a family look. A three-bar `.comp-brand-accent` (blue/red/yellow) sits under the short description, as on the admin head. Holds the status badge, countdown chip, join-mode chip, slug eyebrow, H1 title, short description, join control, and the facts strip.
- **Facts strip** - `<dl>` with three entries: competition window, primary metric, and submission quota. Icon color rotates blue/red/yellow by rendered position (`.comp-fact:nth-child(3n + 1|2|0)`). This is decorative rhythm only; the label text carries the meaning. Yellow uses the contrast-safe `--vku-yellow-800` because 500/700 are too light for a 16px icon stroke.
- **Tab bar** - a route `<nav>`, not a tab widget. The active tab carries `aria-current="page"` and a blue surface; there is no `role="tab"` or `aria-selected`, and no live region is added to the header.

The workspace body is rendered inside `.comp-body`, which keeps the shared card chrome on all four routes - so text inside a workspace is inset by the same padding as the overview regardless of which tab is open. `.content-layout.is-workspace` drops the sidebar column on the three workspace routes; nothing else about the body wrapper changes between tabs.

Content sidebar (`Mục lục nội dung` + `Tài nguyên tải về`) is rendered only on overview/content routes and is absent from the three workspaces.

## 6. Workspace presentation

Each workspace owns its own header and controls and uses the same hierarchy:

| Workspace | Root | Header |
|---|---|---|
| Nộp bài | `.sub-workspace` (2 columns at ≥64rem) | `.sub-header` / `.sub-title` / `.sub-lead` |
| Bài đã nộp | `.subm-page` | `.subm-head` / `.subm-eyebrow` / `.subm-title` / `.subm-lead` |
| Bảng xếp hạng | `.lb-page` | `.lb-head` / `.lb-eyebrow` / `.lb-title` / `.lb-lead` |

Workspace titles are `h2`; the module has exactly one `h1`, in the masthead.

Data surfaces carry their own card chrome (`.sub-specs-strip`, `.sub-upload-card`, `.sub-guide-card`, `.sub-file-card`, `.subm-table-wrap`, `.lb-table-wrap`, `.lb-locked-card`, `.lb-me-strip`). None of them is nested inside another card.

### Nộp bài

Two columns at desktop - upload/result on the left, guidance rail on the right - collapsing to one column in DOM order below 64rem. The blocked-state banner renders `submissionUnavailableMessage()` exactly once, in the existing gate order: membership → published → start → end → readiness → quota. The native file picker button stays the keyboard path. Icons are decorative and `aria-hidden`. No quota figure, progress, or error code is displayed unless it comes from the API or submission config.

The rules ribbon (`.sub-specs-strip`) is a 4-column grid (2 columns below 36rem) holding four format cards - Cột ID, Cột Output, Định dạng, Dung lượng - whose icon color rotates blue/red/yellow by rendered position (decorative; the label text carries the meaning), followed by a `.sub-quota` row spanning the full ribbon width as a fifth grid row.

Value typography inside a card: the label is a small uppercase eyebrow, the value is Inter, and only real identifiers (`id_column`, `prediction_column`) stay in JetBrains Mono - they render as `code` chips. A secondary part of a value (the `positive label` of a binary task) is a `.sub-spec-sub` block on its own line rather than an inline `·` join, so it wraps by design instead of making one card taller than the other three.

- The row reads `Còn {remaining}/{per_day} lượt hôm nay`, taken from `competition.quota`. That sentence is the information channel; the bar is a secondary cue.
- The bar fill is `remaining / per_day` and its color escalates with the remaining level: `--success-bright` above 50%, `--vku-yellow-600` at 50% or below, `--danger` at zero.
- When `competition.quota` is absent (non-member, closed competition, or any state where the backend does not return it), **no bar is drawn at all** - the row falls back to the existing `{quota_per_day} lượt/ngày` sentence. An empty bar would falsely read as "no submissions left".
- The bar track is `aria-hidden`; it never becomes a second live region or a duplicate accessible name.

### Bài đã nộp

Toolbar with summary pills, then the 7-column table inside `.subm-table-wrap` (`role="region"`, `tabIndex={0}`, `aria-label="Bảng bài đã nộp"`, `aria-busy`). IDs, filenames, and scores use mono. The best completed submission **on the current page** gets a yellow row and a text badge - the label says "trong trang" and must not read as a global best. Pagination sits outside the scrolling region and uses `aria-disabled` rather than native `disabled` so focus is retained while refreshing. Previous rows stay on screen during a refresh.

### Bảng xếp hạng

When `leaderboard_visible` is false the page renders the locked card and returns **before any fetch** - zero API requests. The personal rank strip (`.lb-me-strip`) uses blue structure and no new live region. Rank badges: top-1 yellow highlight, top-2/top-3 restrained amber, standard neutral - the rank number is always present as text. The current user's row gets a blue tint plus a `Bạn` badge. The 7-column table lives in `.lb-table-wrap` with the same named focusable-region contract, and pagination sits outside it.

## 7. Markdown presentation layer

Markdown stays the content source. `.md` files are not converted to TSX, are not edited for styling, and their assets are not moved. The pipeline is unchanged: `react-markdown` + `remark-gfm` + `rehype-sanitize`, no `rehype-raw`, no `dangerouslySetInnerHTML`, lazy-loaded as its own chunk.

Presentation lives in `.markdown-body` in `frontend/src/index.css`, so documents added later inherit the VKU style without touching their Markdown or the renderer.

- Author headings are demoted one level by `MarkdownView`, so an author `#` renders as `h2`. That rendered `h2` is the document's top-level section and carries a 4px blue left marker; `h3` gets a light bottom separator. Markdown can never produce a second `h1`.
- Links are blue with an underline and turn red on hover. Blockquotes use a very light blue→yellow wash with a blue left border. Inline code is mono in restrained red on a subtle surface. Code blocks keep the `--code-surface` ink with a yellow top accent and scroll internally. Images are block-level, uncropped, with a light border, radius, and shadow. `hr` uses a small blue–red–yellow stripe.
- GFM tables render inside `.md-table-wrap` - a named, keyboard-focusable region with `overscroll-behavior-x: contain` - and keep native table semantics.
- Image `src` is transformed only for `assets/`-prefixed paths without `..`, resolving to `/api/competitions/{slug}/assets/{rest}`. External and `data:` images resolve to an empty `src` and are dropped. External links get `target="_blank"` and `rel="noopener noreferrer"`; internal links are not forced into a new tab.
- Long slugs, URLs, and identifiers wrap rather than overflow the panel.

No callout syntax is added. The parser does not support it, and adding a dependency for it is out of scope.

## 8. State coverage

Each workspace must render its loading, error, empty, blocked/locked, populated, refreshing, and paginated states from the data it already fetches.

- Loading uses the existing skeleton or status text.
- Errors keep the existing `ErrorBox` / retry affordance and never fall back to an empty state.
- Empty states are factual and offer only actions that already exist.
- Refreshing and paginating retain the previous rows and the focused control.
- Success is communicated with text, not color alone.

## 9. Accessibility and responsive requirements

Verify at 375, 390, 640, 768, 1024, 1200, and 1440px.

- Exactly one `h1` per route, in the masthead. Workspace titles are `h2`.
- Tab navigation uses `<nav>` + `aria-current="page"`. No fake `tablist`.
- Table regions are named, focusable, and show a visible 2px focus ring.
- Decorative SVGs are `aria-hidden="true"` and `focusable="false"`.
- Color is never the only channel; status, quota, ranking, and best-result states always carry text.
- Touch targets are at least ~44px where layout permits.
- The sticky content sidebar does not obscure focused controls at narrow widths.
- No horizontal body overflow; only designated table and code regions scroll.
- `prefers-reduced-motion` is honored; no new animation is introduced.
- Light mode only, `color-scheme: light`.

## 10. Acceptance criteria

- The four routes render one shared shell and one visual language; switching tabs feels like moving inside a product, not between products.
- All four routes render inside the single `68rem` frame; no body overflow at any required width, and wide tables scroll only inside their own regions.
- Documents added to the competition later pick up the VKU style through `.markdown-body` without editing `.md` files or writing TSX.
- Every behavior, security, and accessibility invariant in section 3 is intact.
- Participant, markdown, and app tests pass, and dashboard/admin/about/support pages are unaffected.
