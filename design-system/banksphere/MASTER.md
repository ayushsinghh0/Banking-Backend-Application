# BankSphere design system — MASTER

The single source of truth for how BankSphere looks and behaves. Page-specific overrides go in
`design-system/banksphere/pages/<page>.md`; where one exists it wins, otherwise this file applies.

Built with the ui-ux-pro-max skill. It picked the **Minimalism & Swiss** style, the **Banking / Traditional Finance**
palette family (ink primary, navy-blue trust accent, slate neutrals, white surfaces) and the **Minimal Swiss**
type pairing (Inter only, hierarchy from weight and size). Direction: Apple (apple.com, Apple Card, Wallet) and
Google (Google Wallet, Material 3).

## Principles

1. **Typography carries the hierarchy.** One large title per screen, then headline-size section titles. No
   decorative icons doing a heading's job.
2. **Colour means something.** Ink and greys for everything; green only for money in, amber for "needs attention",
   red only for errors, destructive actions and critical risk. Blue (`primary`) is for links, focus, selection and
   the one data series in a chart. Money going out is ink, never red.
3. **Tiles, not boxes.** White tiles (`Card`, 18px radius) on a soft canvas. No borders around tiles and no
   drop shadows; inside a tile, separate rows with hairlines (`divide-y`), not nested boxes.
4. **One primary action per view.** Primary = ink pill (`Button` default). Secondary = grey pill
   (`variant="secondary"`). Outline only where a lighter third weight is needed.
5. **Phones are first-class.** Bottom tab bar, bottom-sheet dialogs, 44px+ targets, 16px input text, safe areas.
   Every page must look designed at 390px, not merely fit.
6. **Say less, precisely.** Short sentence-case labels. No marketing copy inside the app.

## Banned ("AI template" tells)

- Icons inside tinted rounded squares or circles next to stats, list rows or headings (`bg-primary-soft`
  icon tiles). If an icon helps, render it bare in `text-muted-foreground`, or a neutral `bg-muted` circle for
  transaction-type glyphs only.
- UPPERCASE tracking-wide eyebrow labels and column headers. Use sentence case.
- Gradients (except the tiny account-card swatches), glows, glassmorphism panels, decorative grids.
- Rows of identical stat cards when the numbers are not equally important. Make the important one big.
- Red for ordinary debits. A badge on every row saying "Active".
- Filler copy ("Here's where your money stands today"), date eyebrows, "Secure session" chips.
- Raw backend strings like `[INBOUND]`, enum names like `PENDING_APPROVAL`. Humanise them.

## Tokens (see `frontend/src/styles/index.css`, `frontend/tailwind.config.ts`)

| Role | Light | Dark | Tailwind |
|---|---|---|---|
| Canvas (page) | #F5F5F7 | #000000 | `bg-canvas` |
| Tile | #FFFFFF | #1C1C1E | `bg-card` |
| Popover / sheet | #FFFFFF | #252527 | `bg-popover` |
| Text | #1D1D1F | #F5F5F7 | `text-foreground` |
| Secondary text | #6C6C71 (4.7:1 on canvas) | #A1A1A6 | `text-muted-foreground` |
| Ink (primary action) | #1D1D1F | #F5F5F7 | `bg-ink text-ink-foreground` |
| Accent (links, focus, selection) | #0066CC | #3399FF | `text-primary`, `ring-ring` |
| Fill (grey controls, skeletons) | #EEEEF0 | #2A2A2C | `bg-muted`, `bg-secondary` |
| Hover tint | #F2F2F4 | #262628 | `bg-accent` |
| Hairline | #E3E3E8 | #323234 | `border`, `divide-y` |
| Money in | green | green | `text-success` |
| Attention | amber | amber | `warning` |
| Error / critical | red | red | `destructive` |

Radii: controls `rounded-xl` (14px), tiles `rounded-2xl` (18px), sheets 24–28px, pills `rounded-full`.
Shadows: `shadow-card` (hairline only), `shadow-raised` (hover cards), `shadow-elevated` (menus, dialogs),
`shadow-thumb` (segmented control thumb).

## Type scale (Inter Variable with optical sizing)

| Use | Class |
|---|---|
| Screen title | `large-title` (28/34 → 32/38, bold, -0.026em) |
| Hero figure (balance) | `text-[40px] sm:text-[52px] font-semibold tracking-[-0.04em]` with `BigAmount` |
| Section / tile title | `text-headline` (17px semibold) |
| Dialog title | `text-title-3` (20px semibold) |
| Body | 15px (`text-[15px]`) |
| Secondary / meta | 13–14px `text-muted-foreground` |
| Group label above rows | `group-label` (13px semibold muted) |
| Numbers | always `tnum` |

## Layout grid

- Customer pages: max width 1120px. Staff pages: max width 1320px. Gutters 16px (phone) / 24px (tablet) /
  40px (desktop). The shell provides these; pages never add their own outer padding.
- 12-column grid at `lg`: `grid gap-5 lg:grid-cols-12 lg:gap-6`. Main content 8 columns, side panel 4.
  Forms and single-task flows: one centred column, `max-w-2xl`.
- Vertical rhythm: `space-y-6 lg:space-y-8` between page sections; 16/24px inside tiles.

## Components (in `frontend/src/components/ui`)

- `PageHeader` — title, optional description, actions on the right. Do not pass `eyebrow` unless it is real
  context (for example a breadcrumb back link).
- `Card` + `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter` — tiles.
- `Button` — pills. `size="lg"` (48px) for the main action of a form, and on phones in sheets.
- `Field` + `Input`/`PasswordInput`/`OtpInput`/`NativeSelect`/`Textarea`/`MoneyInput` — labelled fields, 44px.
- `Badge`/`StatusBadge` — soft pills with a dot. Use only where status varies and matters.
- `Callout` — soft tinted banner for info/success/warning/danger.
- `DataTable` + `Pagination` — sentence-case headers, hairline rows. On phones, prefer a row list
  (title, meta line, trailing value, chevron) over a squeezed table: use `hideOnMobile` on secondary columns
  and make the first column carry the essentials.
- `Tabs` — the segmented control (pill track, white thumb). Never wrap: it scrolls horizontally.
- `Dialog`/`ConfirmDialog` — centred on desktop, bottom sheet on phones, automatically.
- `EmptyState`/`ErrorState` — bare glyph, headline, one sentence, one action.
- `BigAmount` — rupees in full weight, paise quieter. `Amount` — signed, money in green.
- `Avatar` — grey contact-style monogram.

## Patterns

- **Lists of things** (accounts, payees, requests, alerts on phones): a tile with rows. Row = 40px leading
  element (neutral glyph circle, account swatch or avatar) · title 15px medium · meta 13px muted · trailing value
  or status · chevron if it navigates. Rows separated by `divide-y divide-border/70`.
- **Selection cards** (radio choices in dialogs): `rounded-xl border p-4`, checked state
  `has-[:checked]:border-primary has-[:checked]:bg-primary-soft/50` plus a visible check.
- **Detail pages**: a header tile with the key figure or status, then a two-column grid (8/4) of tiles.
- **Key figure tiles** (staff overview): one row of up to 4 figures inside a single tile divided by hairlines,
  value 28px semibold, label above in 13px muted, clickable to the queue. No icons.
- **Charts**: one series in `primary`, others in ink/grey. No gridlines unless reading values needs them.
  Tooltips use `bg-popover shadow-elevated rounded-xl`. Always a text alternative.

## Motion

200ms ease-out for hover/press colour changes; `active:scale-[0.97]` on buttons; pages rise in 280ms;
sheets/dialogs 300ms spring. Everything respects `prefers-reduced-motion`.

## Accessibility (non-negotiable)

Text contrast 4.5:1 in both themes · visible focus ring (blue) · 44px touch targets on phones · labels on
every field · visible text contained in the accessible name (WCAG 2.5.3) · one `h1` per page · regions named
when tests or assistive tech rely on them · colour never the only signal (badges have text, amounts have signs).

## Pre-delivery checklist

- [ ] Checked at 390px and 1440px, light and dark
- [ ] No banned patterns above
- [ ] Every money figure `tnum`, debits ink, credits green with "+"
- [ ] One primary (ink) action per view
- [ ] Unit tests green; e2e selectors in `frontend/e2e/journeys/bank-day.spec.ts` still match
