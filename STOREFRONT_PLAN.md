# Haubaboss Storefront — Feasibility & Implementation Plan

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
| `haubaboss-frontend` | Admin/inventory app + landing | Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui, BFF pattern (server actions proxy to Laravel) |
| `gift-shop` | Reference implementation | Laravel 13 API + Next.js storefront (`apps/web`) + Next.js admin (`apps/admin`), monorepo |

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

## 6. Frontend changes (`haubaboss-frontend`)

Recommendation: **one app, new public route group** — `app/(shop)/*` — rather than a
separate storefront app like gift-shop's monorepo. Haubaboss already serves tenant
domains from a single Next.js app with host-aware middleware; a route group keeps
deployment unchanged. (Splitting into a separate app later is straightforward if needed.)

- **Public shop pages** (`app/(shop)`, host-resolved tenant, no auth):
  - Shop home: branding + featured/latest parts
  - Parts listing with faceted filters (reuse catalog cascades from `AddPartForm` in
    read-only form) + search
  - Part detail: gallery (lightbox already in the stack), quality, price, donor vehicle,
    add-to-cart
  - Cart + checkout (COD form: name, phone, address) + order-confirmation page
- **Admin additions** (inside existing `app/(root)`):
  - `orders/` list + `orders/[id]` detail with state-transition actions (port gift-shop's
    orders pages; table stack — TanStack Table — is already in place)
  - `settings/shop` — branding, shipping, shop on/off
  - Shop switcher in the sidebar/topbar (memberships from `/auth/profile`); server actions
    attach `X-Company`
  - "Create new shop" flow (name, subdomain — reuses existing tenant-domain machinery)
- **Routing note:** the shop takes over the tenant-domain root; the existing admin app
  stays reachable via `/login` → `/(root)` routes on the same host (current behavior),
  so no domain migration is needed.

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
| **2. Public storefront (read-only)** | `ResolveShopTenant`, public parts/catalog/search endpoints, `(shop)` route group: home, listing, part detail | ~1.5–2 wk |
| **3. Commerce** | Cart, checkout (COD, guest), Order/OrderItem + state machine + reservation + ledger integration, admin orders pages, order status page | ~2–3 wk |
| **4. Shop management parity** | Create-shop flow, branding/shipping settings, shop on/off, polish (emails/notifications on new orders) | ~1–1.5 wk |
| **Total (COD MVP at gift-shop parity)** | | **~6–8 weeks** solo, less if gift-shop code is ported aggressively |

Deferred (post-MVP): customer accounts, refunds, online payments, layout manager,
zeus impersonation, central cross-shop search/aggregator page.

## 9. Risks & decisions

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
