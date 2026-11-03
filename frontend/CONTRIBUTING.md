# Frontend conventions

These rules keep every screen consistent, accessible and safe. Read them before adding a page.

## Stack

React 18 + TypeScript (strict, `noUncheckedIndexedAccess`) · Vite · Tailwind with CSS-variable design tokens
(`src/styles/index.css`) · Radix primitives · TanStack Query · React Hook Form + Zod 4 · React Router 7 ·
Recharts · lucide-react · sonner toasts. Tests: Vitest 5 + Testing Library + MSW 2; Playwright for end to end.

## Layout of `src/`

| Path | What lives there |
|---|---|
| `lib/money.ts` | Paise ↔ rupees. **Never** use `Number`/floats for money; amounts are paise strings end to end. |
| `lib/api/` | `client.ts` (fetch, auth header, refresh-on-401, errors), `endpoints.ts` (every API call, typed), `types.ts`, `errors.ts` (`ApiError`, `describeError` message catalog). |
| `lib/auth/` | `session.ts` (in-memory access token, cookie refresh, cross-tab logout), `AuthProvider.tsx` (`useAuth`, `useUser`, `useApi`). |
| `lib/query.ts` | Query client defaults and **all query keys** (`qk`). |
| `lib/validation.ts` | Shared Zod schemas (email, password policy, TOTP, account number, phone, `rupeesSchema`). |
| `lib/notify.ts` | `notifyError`, `notifySuccess`, `newIdempotencyKey`. |
| `components/ui/` | Design-system components. Reuse them; don't restyle per page. |
| `components/layout/` | App shell, auth layout, brand. |
| `features/security/StepUp.tsx` | `useStepUp().run(action)` for high-value actions. |
| `features/<area>/` | Pages (`<Name>Page.tsx`, default export) and their tests (`<Name>Page.test.tsx`). Page-specific components go in `features/<area>/components/`. |
| `test/` | `render.tsx` (`renderWithApp`, `renderRoute`, `apiUrl`, `ok`, `fail`), `fixtures.ts` (factories + `IDS`), `tokens.ts`. |

## Rules

1. **Test first.** Write the page test (behaviour, not markup) before the page. Cover: loading, empty, error
   (with retry), the happy path, every API error code the endpoint can return that changes what the user sees,
   role differences, and validation. Use MSW handlers via `server.use(...)`; unhandled requests fail the test.
   Query by role/label/text the way a user would (`getByRole('button', { name: ... })`).
2. **Money.** Inputs use `MoneyInput` + `rupeesSchema()`; display uses `<Amount>` or `formatPaise`. Compare
   with `comparePaise`/BigInt.
3. **Money-moving requests** (transfer, deposit, withdraw, cash approval) need an idempotency key. Create it once
   per intent with `newIdempotencyKey()` (e.g. when the review step opens), keep it in state, and reuse it for
   retries of that same intent; make a new one only for a new intent. Wrap the call in `useStepUp().run(...)`
   where step-up can be required (transfers ≥ ₹1,00,000, withdrawal codes ≥ ₹25,000, instant payees).
4. **Errors.** Show API errors with `describeError` (inline `Callout` in forms, `notifyError` toast for
   background actions). Map field errors from `error.fieldErrors` onto the form. Never show raw JSON.
5. **Data fetching.** `useQuery({ queryKey: qk.x(...), queryFn: () => api.x(...) })`. After a mutation,
   invalidate exactly the keys it changes. Lists use `DataTable` with `loading`, `error`, `onRetry`, `empty`.
   Paginated lists use `Pagination` (offset/limit; the API has no totals).
6. **Accessibility.** Every control has a visible label (`Field`). Icon-only buttons need `aria-label`.
   Destructive or irreversible actions go through `ConfirmDialog`. Don't rely on colour alone (badges have text).
7. **Security-sensitive UX.** Never display data the API hides (expected cash before sign-off). Keep
   anti-enumeration wording ("If the address can receive email…"). Show a withdrawal code once, with copy.
8. **Look and feel.** Page = `PageHeader` + `Card`s on the canvas. Use tokens (`text-muted-foreground`,
   `bg-card`, `text-success`), never raw hex. Use `tnum` for numbers. Keep spacing on the 4 px grid
   (`gap-4`, `space-y-6`). Mobile first: everything must work at 360 px.
9. **Copy.** Plain, specific, calm. Sentence case. Say what happened and what to do next.

## Commands

```bash
npm run dev          # http://localhost:3000, proxies /api to the gateway (VITE_DEV_GATEWAY_URL)
npm test             # unit + component tests
npm run test:coverage
npm run typecheck && npm run lint
npm run build
npm run e2e          # Playwright against a running stack (see e2e/README.md)
```
