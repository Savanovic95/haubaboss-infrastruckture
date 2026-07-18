# Haubaboss Infrastructure

Edge routing and deployment config for the Haubaboss platform:

| App | Repo | Served at |
|---|---|---|
| Laravel API | `haubaboss-backend` | `/api/v1/*`, `/sanctum/*`, `/storage/*` on every host |
| Admin app (staff) | `haubaboss-frontend` | apex + `www` (marketing/landing) and `admin.{MAIN_DOMAIN}` (sign-in + shop switcher) |
| Storefront (buyers) | `haubaboss-store` | `{subdomain}.{MAIN_DOMAIN}` and tenant custom domains |
| PostgreSQL 16 | — | internal |

## Routing model

- One storefront deployment serves **all** shops; the shop is resolved from
  the request host (`X-Shop-Host` forwarded by the store's BFF to the API).
- Staff sign in on `admin.{MAIN_DOMAIN}` and switch between their shops via
  memberships (`X-Company` header, handled by the admin app's BFF).
- TLS for tenant subdomains and custom domains is issued on demand, gated by
  the backend's `/api/internal/tls-check` endpoint so only real tenant hosts
  ever get certificates.

## Usage

```bash
cp .env.example .env   # fill in secrets
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec backend php artisan migrate --force
```

The compose file uses sibling-directory build contexts
(`../haubaboss-backend` etc.); CI pipelines can swap `build:` for prebuilt
images.

See `STOREFRONT_PLAN.md` for the storefront feasibility study and the phased
implementation plan this infrastructure belongs to.
