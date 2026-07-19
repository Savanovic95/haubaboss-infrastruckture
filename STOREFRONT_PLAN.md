# Haubaboss Storefront — Feasibility & Implementation Plan

> **Implementation status (2026-07-19):**
> - ✅ Backend complete on `haubaboss-backend@claude/storefront` — memberships/multi-shop, public shop API, guest carts, COD checkout, order state machine, staff order endpoints, shop settings + storefront on/off, admin-host login. 193 PHPUnit tests green.
> - ✅ Storefront app built in `haubaboss-store` (local repo, push pending GitHub repo creation) — browse/search/detail, cart, COD checkout, guest order status. 36 Vitest tests green, production build green.
> - ✅ Edge routing (`caddy/Caddyfile`, validated) + `docker-compose.prod.yml` in this repo.
> - ✅ Playwright e2e critical path (`e2e/`) passing against the real stack.
> - 🔄 Admin app (orders UI, shop switcher, create-shop, settings) in progress on `haubaboss-frontend@claude/storefront`.

**Goal:** Add per-scrapyard public storefronts to Haubaboss, with admin shop management
modeled on the gift-shop platform: each scrapyard (company) gets its own shop on its own
subdomain/custom domain, and one admin user can own and manage multiple shops.

**Verdict: feasible, medium-sized project.** Haubaboss and gift-shop are architecturally
near-twins (Laravel API + Next.js, Sanctum, subdomain/custom-domain multi-tenancy, a
`zeus` super-admin tier). The gift-shop serves as a working reference implementation for
everything Haubaboss is missing: cart, checkout, orders, and order-management admin.

---

## 1. Repos involved

| Repo | Role | Stack |
|---|---|---|
| `haubaboss-backend` | API | Laravel 12, PostgreSQL 16, Sanctum (Bearer tokens), S3 media |
| `haubaboss-frontend` | **Admin app** (inventory + shop management) + landing | Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui, BFF pattern (server actions proxy to Laravel) |
| `haubaboss-store` **(new repo)** | **Public storefront** — buyer-facing shops, one deployment serving all tenant domains | Next.js (same stack as haubaboss-frontend), host-based tenant resolution |
| `haubaboss-infrastruckture` | Edge routing + deployment config (Caddy, compose) for the three apps | Caddy, Docker Compose, CI |
| `gift-shop` | Reference implementation | Laravel 13 API + Next.js storefront (`apps/web`) + Next.js admin (`apps/admin`), monorepo |

This mirrors gift-shop's split exactly: `apps/admin` ↔ `haubaboss-frontend`,
`apps/web` ↔ `haubaboss-store`, `apps/api` ↔ `haubaboss-backend` — just as separate
repos instead of a monorepo.

## 2. What Haubaboss already has (reuse as-is)

- **Sellable inventory.** `Part` already carries `selling_price`, `currency`, `quantity`,
  `quality`, `is_available`, `is_reserved`, media galleries (`app/Models/Part.php`).
  A Part *is* the product — no new product model needed.
- **Owner admin for inventory.** Company `admin` users already do product management:
  add/edit/delete parts, prices, availability, photos (`haubaboss-frontend`:
  `app/(root)/parts`, `add-part`, `add-vehicle`). This is the gift-shop "Products CRUD"
  equivalent, already built.
- **Multi-tenancy per scrapyard.** `Company` has `subdomain` + `custom_domain`, Caddy
  does per-tenant TLS (`/internal/tls-check`), login is host-restricted. Same pattern as
  gift-shop tenants.
- **Rich catalog taxonomy.** Manufacturer → Series → VehicleModel → Variant →
  PartsGroup → MasterPart. Perfect for faceted storefront search (gift-shop only has flat
  categories — Haubaboss is *better* positioned here).
- **Sales ledger.** `InventoryTransaction` (types: sale/purchase/return/removal/adjustment)
  with `unit_price`, `total_amount`, customer name/phone. Orders will write into this
  ledger instead of replacing it.
- **Zeus tier.** Companies, users, tenant-domains, observability management already exist.

## 3. What gift-shop provides as the blueprint (port these)

| Gift-shop piece | Location | Port to Haubaboss as |
|---|---|---|
| Cart w/ guest support (signed `cart_token` cookie, server-side stock guard) | `apps/api` Cart/CartItem, `apps/web/src/lib/cart-store.ts` | Same design; cart items reference `part_id` |
| Checkout (COD, guest allowed, VAT breakdown) | `apps/api/app/Services/CheckoutService.php` | `CheckoutService` creating Orders from carts |
| Order lifecycle | `apps/api/app/Services/OrderStateMachine.php` (`pending → confirmed → packed → shipped → paid`, cancel restocks) | Same state machine; terminal transitions write `InventoryTransaction` rows |
| Order/OrderItem model (denormalized line items, guest `user_id` nullable, shipping snapshot) | `apps/api/app/Models/Order.php` | Company-scoped `Order`/`OrderItem` |
| Admin order management UI | `apps/admin/src/app/(app)/orders/` | New pages in haubaboss-frontend |
| Multi-shop ownership (user ↔ shop membership pivot, per-shop roles) | `Membership` model + spatie/laravel-permission teams mode, `ROLES.md` | `company_user` membership pivot (see §5) |
| Shop switcher / tenant context | `X-Tenant` header + `GET /api/user` memberships | `X-Company` header + extended `/auth/profile` |
| Shop creation by an existing admin | `POST /shops`, `apps/admin/(app)/shops/new` | `POST /companies` opened to admins (own shops only) |
| Branding/shipping/FAQ settings | `apps/admin/(app)/settings/*` | Company settings pages (Company already has `settings` JSON) |
| Zeus impersonation ("act as" shop) | `X-Act-As-Tenant`, `lib/impersonation.ts` | Optional, Phase 4 |

**Payments:** gift-shop is **cash-on-delivery only** — no payment gateway anywhere.
Matching its feature set means COD for Haubaboss too, which removes the largest risk
item. Online payments can be added later as an independent phase.

## 4. Gaps in Haubaboss (net-new work)

1. **No public surface.** Every backend endpoint is behind `auth:sanctum`; every frontend
   page behind login. Need unauthenticated, host-scoped shop endpoints + public pages.
2. **No order domain.** No Cart/Order/OrderItem. The existing `POST /parts/{part}/sell`
   is a staff point-of-sale action, not a customer order flow.
3. **Single-company users.** `users.company_id` is a single FK; gift-shop's "one admin,
   many shops" requires a membership pivot. **This is the deepest structural change** and
   should land early because everything else builds on company context resolution.
4. **No customer identity.** All four roles (zeus/admin/manager/worker) are staff roles.
   Gift-shop solves the cheap way: guest checkout (name/phone/address on the order, no
   account). Recommended for MVP; customer accounts are a later phase.
5. **No reservation workflow.** `is_reserved` exists on Part but nothing drives it — the
   order flow will (reserve on order placed, release on cancel, decrement on completion).

## 5. Backend changes (`haubaboss-backend`)

### 5.1 Multi-shop memberships (enabler, do first)

- New `company_user` pivot: `user_id`, `company_id`, `role` (reuse `UserRole` enum values
  admin/manager/worker), `status`, timestamps. Unique on (`user_id`,`company_id`).
- Backfill migration: every existing `users.company_id` + `users.role` becomes one
  membership row. Keep the old columns during a deprecation window, then drop.
- `CompanyScopeMiddleware` resolves active company from an `X-Company` header validated
  against the user's memberships (zeus bypasses, as today).
- `GET /auth/profile` returns the membership list so the frontend can render a shop
  switcher (mirrors gift-shop's `GET /api/user`).
- `POST /companies` allowed for `admin`-tier users creating **their own** additional
  shops (creator gets an admin membership); zeus keeps full CRUD.

### 5.2 Public shop API (unauthenticated, host-scoped)

New route group `/api/v1/shop/*` behind a `ResolveShopTenant` middleware (company from
`Host`/`X-Shop-Host`, mirroring gift-shop's `IdentifyTenant`/`HostResolver`):

- `GET /shop/info` — company name, logo, branding, contact
- `GET /shop/parts` — paginated, filterable (manufacturer/series/model/variant/parts-group,
  quality, price range, text search); only `is_available = true`, `quantity > 0`, not reserved
- `GET /shop/parts/{id}` — part detail + media + donor-vehicle info
- `GET /shop/catalog/*` — facet lists scoped to what the shop actually stocks
- Cart: `GET/POST/PATCH/DELETE /shop/cart(/items)` — guest cart via signed `cart_token`
  cookie (gift-shop pattern), server-side stock validation on every write
- `POST /shop/checkout` — creates Order (COD), reserves stock
- `GET /shop/orders/{id}/{token}` — guest order status via signed token

### 5.3 Order domain

- **Order** (company-scoped): number, status, customer snapshot (name/phone/email/address),
  totals in cents, `payment_method = 'cod'`, per-state timestamps, nullable `user_id`.
- **OrderItem**: `order_id`, `part_id`, denormalized name/quality/price, quantity.
- **Cart / CartItem** (company-scoped, guest or user-owned).
- **OrderStateMachine** ported from gift-shop: `pending → confirmed → packed → shipped → paid`;
  `cancel` releases reservation/restocks. Completion writes `InventoryTransaction` (type
  `sale`) so the existing ledger and dashboard stats stay the source of truth.
- Reservation: placing an order decrements available quantity or sets `is_reserved`
  (single-quantity parts are the common case in scrapyards); cancel releases it.
- Staff endpoints: `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/transition`
  (company-scoped, `worker`+ can view, `manager`+ can transition — tune as desired).

### 5.4 Shop settings

- Extend `Company.settings` JSON (already exists) with branding (hero, theme, about text),
  shipping options (flat fee / pickup at yard), and shop enabled/disabled flag.
- `GET/PUT /companies/{id}/settings` for admins of that company.

## 6. Frontend changes

### 6.1 New storefront repo: `haubaboss-store` (buyer-facing, public)

A separate Next.js app — the counterpart of gift-shop's `apps/web`. One deployment
serves **all** scrapyard shops; the tenant is resolved from the request `Host`
(subdomain or custom domain), same as gift-shop's storefront.

- Bootstrap with the same stack as `haubaboss-frontend` (Next.js App Router, Tailwind v4,
  shadcn/ui) and the same OpenAPI type-generation setup (`gen:api-types` pointed at the
  backend spec) so the two frontends share the API contract discipline.
- Pages:
  - Shop home: branding + featured/latest parts
  - Parts listing with faceted filters (manufacturer → series → model → variant,
    parts group, quality, price) + full-text search
  - Part detail: photo gallery, quality, price, donor-vehicle info, add-to-cart
  - Cart + checkout (COD form: name, phone, address) + order-confirmation page
  - Guest order-status page (signed token link)
- Calls only the public `/api/v1/shop/*` endpoints (§5.2) — no staff auth anywhere in
  this app, which keeps its security surface minimal.
- Cart state: Zustand + signed `cart_token` cookie, ported from gift-shop's
  `apps/web/src/lib/cart-store.ts`.

### 6.2 Admin additions (existing `haubaboss-frontend` — stays the admin app)

- `orders/` list + `orders/[id]` detail with state-transition actions (port gift-shop's
  orders pages; table stack — TanStack Table — is already in place)
- `settings/shop` — branding, shipping, shop on/off
- Shop switcher in the sidebar/topbar (memberships from `/auth/profile`); server actions
  attach `X-Company`
- "Create new shop" flow (name, subdomain — reuses existing tenant-domain machinery)

### 6.3 Edge routing (`haubaboss-infrastruckture` / Caddy)

Today, tenant subdomains and custom domains serve the admin app. With a dedicated store
app, routing becomes:

- **Tenant domains** (`{shop}.haubaboss…` + custom domains, via on-demand TLS /
  `/internal/tls-check`) → **`haubaboss-store`** container
- **Admin domain** (main app domain, e.g. the current primary host or a dedicated
  `admin.` subdomain) → **`haubaboss-frontend`** container
- `/api/v1/*`, `/sanctum`, `/storage` → Laravel backend (unchanged)
- Admin login's host restriction (`X-Login-Host`) moves with the admin domain: tenant
  staff log in on the admin domain and pick their shop via the switcher, instead of
  logging in on their tenant domain. (Alternative: keep `/admin`-prefixed routes on
  tenant domains routed to the admin app — decide during Phase 2.)
- `docker-compose` gains one service (`store`), CI gains one build/deploy pipeline —
  both are copy-adapt from the existing frontend's setup (gift-shop's
  `docker-compose.prod.yml` shows the exact three-app shape: caddy, api, web, admin).

## 7. Admin feature parity with gift-shop

| Gift-shop admin feature | Haubaboss status |
|---|---|
| Products CRUD + media | ✅ exists (parts management) |
| Inventory/stock | ✅ exists (quantity, ledger) |
| Orders + state machine | 🆕 Phase 2 |
| Categories | ✅ covered by global catalog taxonomy (zeus-curated) |
| Multiple shops per admin | 🆕 Phase 1 (membership refactor) |
| Shop creation by admin | 🆕 Phase 3 |
| Branding settings | 🟡 partial (logo exists) → Phase 3 |
| Shipping settings | 🆕 Phase 3 |
| Customers management | ⏭ later (guest checkout first) |
| Refund requests | ⏭ later (gift-shop gates it behind a platform flag anyway) |
| Layout manager / page sections | ⏭ later, optional |
| FAQs / newsletter | ⏭ later, optional |
| Zeus: tenants, users, domains, platform settings | ✅ mostly exists; impersonation optional later |

## 8. Phased roadmap

| Phase | Scope | Estimate |
|---|---|---|
| **1. Foundations** | `company_user` membership pivot + backfill, `X-Company` context, shop switcher UI, profile endpoint changes | ~1–1.5 wk |
| **2. Public storefront (read-only)** | Bootstrap `haubaboss-store` repo (+ Docker/CI/Caddy routing), `ResolveShopTenant`, public parts/catalog/search endpoints, store pages: home, listing, part detail | ~2–2.5 wk |
| **3. Commerce** | Cart, checkout (COD, guest), Order/OrderItem + state machine + reservation + ledger integration, admin orders pages, order status page | ~2–3 wk |
| **4. Shop management parity** | Create-shop flow, branding/shipping settings, shop on/off, polish (emails/notifications on new orders) | ~1–1.5 wk |
| **Total (COD MVP at gift-shop parity)** | | **~6.5–8.5 weeks** solo, less if gift-shop code is ported aggressively |

Deferred (post-MVP): customer accounts, refunds, online payments, layout manager,
zeus impersonation, central cross-shop search/aggregator page.

## 9. Development methodology: TDD

All phases are developed **test-first** (red → green → refactor): write the failing
test that specifies the behavior, implement until green, then refactor. No feature
code lands without the test that motivated it, and CI stays green on every merge.

- **Backend (`haubaboss-backend`)** — PHPUnit feature tests drive every endpoint and
  state change, extending the existing suite (`tests/Feature/`). Test-first targets per
  phase:
  - Phase 1: membership pivot (backfill correctness, `X-Company` resolution, cross-company
    access denied, zeus bypass) — extend `UserManagementTest` / `TenantLoginRestrictionTest`
    patterns.
  - Phase 2: public shop endpoints (host resolution, only available+in-stock parts
    exposed, no auth leakage of other tenants' data, facet scoping).
  - Phase 3: cart/checkout/orders — state-machine transition matrix (every allowed and
    forbidden transition), reservation + release on cancel, ledger writes on completion,
    guest token access, stock-race guards. Gift-shop's Pest tests serve as the spec
    reference; port their cases to PHPUnit.
  - Phase 4: settings validation, create-shop flow (creator gets admin membership).
- **Admin frontend (`haubaboss-frontend`)** — Vitest + Testing Library, extending the
  existing 22-file suite; `npm run verify` (tsc + vitest) must pass before every commit.
  New tests for the shop switcher, orders table/transitions, and settings forms.
- **Storefront (`haubaboss-store`)** — bootstrapped with the same Vitest + Testing
  Library setup **from the first commit**; unit/component tests for cart store, checkout
  form validation, and tenant resolution.
- **End-to-end** — Playwright suite (gift-shop's `e2e/` is the template) covering the
  critical path: browse → part detail → add to cart → COD checkout → order appears in
  admin → owner transitions it to completion. Runs in CI against a seeded stack before
  deploy.
- **CI gates** — each repo's pipeline runs its full test suite; deploy jobs depend on
  green tests (the backend's PostgreSQL-backed CI job and the frontend's `verify` script
  already exist — the store repo copies this setup).

## 10. Risks & decisions

- **Membership refactor touches auth everywhere** — do it first, behind tests
  (backend already has a strong Pest/PHPUnit-style suite to extend).
- **Laravel 12 vs 13:** gift-shop code ports as *patterns and mostly-copyable classes*,
  not drop-in files. `CheckoutService`/`OrderStateMachine` have no framework-version
  coupling to speak of.
- **Auth style differs:** Haubaboss uses Bearer tokens via the Next BFF; gift-shop uses
  Sanctum SPA cookies. Keep the Haubaboss BFF pattern — ported admin UI adapts to server
  actions instead of TanStack Query where convenient.
- **Single-quantity inventory:** scrapyard parts are usually one-of-a-kind, so
  reservation-on-order (not just decrement-on-payment) matters more than in the
  gift-shop; plan a reservation expiry (e.g., auto-release unconfirmed orders after N days).
- **Registration gap:** backend `AuthController::register` has a known TODO (users not
  attached to a company on public signup) — the membership work naturally fixes this.
