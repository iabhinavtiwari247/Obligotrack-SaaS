# ObligoTrack
<img width="1024" height="1024" alt="Obligotrack - Logo" src="https://github.com/user-attachments/assets/d6ad86c4-c788-4214-9233-450cd5d47dc8" />

**Never miss a compliance obligation again.**

B2B SaaS for compliance, contract & obligation tracking — built for CFOs, Compliance Heads, and Operations Managers in regulated industries.

---

## Architecture Overview

```
obligotrack/
├── apps/
│   ├── web/          # Next.js 14 (App Router, TypeScript)
│   └── api/          # NestJS (TypeScript, REST API)
├── packages/
│   └── shared/       # Shared types & enums
├── infra/
│   └── db/migrations # PostgreSQL schema
└── docker-compose.yml
```

**Tech Stack**
| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 + TypeScript + Tailwind CSS |
| Backend  | NestJS + TypeScript |
| Database | PostgreSQL 16 |
| Cache    | Redis (for session, rate-limit) |
| Auth     | JWT (access 15min + refresh 7d) + RBAC |
| Indian Payments | Razorpay (UPI, Cards, Net Banking) |
| Intl Payments   | Stripe (Cards, PayPal) |
| Email    | Nodemailer (SMTP) |
| Scheduler| @nestjs/schedule (cron) |
| Container| Docker + Docker Compose |

---

## Quick Start

### 1. Prerequisites
- Node.js 18+, pnpm 8+
- Docker & Docker Compose

### 2. Clone & Configure

```bash
git clone https://github.com/yourorg/obligotrack.git
cd obligotrack
cp .env.example .env
# Edit .env with your credentials
```

### 3. Start with Docker (recommended)

```bash
docker-compose up -d          # Start postgres + redis
pnpm install                  # Install all workspaces
pnpm --filter @obligotrack/api migrate   # Run DB migrations
pnpm dev                      # Start both apps in parallel
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:4000
- Swagger docs: http://localhost:4000/docs

### 4. Development (no Docker)

```bash
# Terminal 1 — API
cd apps/api && pnpm dev

# Terminal 2 — Web
cd apps/web && pnpm dev
```

---

## Payment Integration

### Indian Payments — Razorpay

Supports: UPI (PhonePe, GPay, Paytm, all UPI apps), Debit/Credit Cards, Net Banking, Wallets.

**Setup:**
1. Create account at [razorpay.com](https://razorpay.com)
2. Go to Settings → API Keys → Generate Key
3. Add to `.env`:
```env
RAZORPAY_KEY_ID=rzp_live_xxxx
RAZORPAY_KEY_SECRET=your_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
```
4. Configure webhook in Razorpay Dashboard:
   - URL: `https://api.yourdomain.com/api/v1/payments/webhook/razorpay`
   - Events: `payment.captured`, `payment.failed`
5. In Razorpay Dashboard → Settings → Bank Account, link your Indian bank account. All payments settle automatically within T+2 business days.

**Flow:**
```
User selects plan → POST /payments/razorpay/create-order
→ Razorpay Checkout modal (UPI/Card/NB)
→ Payment success
→ POST /payments/razorpay/verify (HMAC signature check)
→ Subscription activated → Confirmation email sent
```

**Fallback webhook:** If user closes browser before verify, the `payment.captured` webhook fires and activates subscription server-side.

---

### International Payments — Stripe

Supports: Visa, Mastercard, Amex, PayPal, international debit cards.

**Setup:**
1. Create account at [stripe.com](https://stripe.com)
2. Get API keys from Dashboard → Developers → API Keys
3. Add to `.env`:
```env
STRIPE_SECRET_KEY=sk_live_xxxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxx
```
4. Configure webhook:
   - URL: `https://api.yourdomain.com/api/v1/payments/webhook/stripe`
   - Events: `checkout.session.completed`, `checkout.session.expired`
5. In Stripe Dashboard, add your Indian bank account under Payouts for automatic settlement.

**Flow:**
```
User selects plan → POST /payments/stripe/create-session
→ Redirect to Stripe Checkout (hosted page)
→ Payment success → Stripe sends webhook
→ Subscription activated server-side → Confirmation email sent
→ User redirected to /payment/success
```

---

### Pricing Plans

| Plan | Price | Period | Savings |
|------|-------|--------|---------|
| Monthly | ₹6,000 | /month | — |
| Half-Yearly | ₹32,500 | /6 months | Save ₹3,500 |
| Yearly | ₹65,000 | /year | Save ₹7,000 |

---

## User Roles & Permissions

| Action | Admin | Manager | Owner | Auditor |
|--------|-------|---------|-------|---------|
| Create obligation | ✅ | ✅ | ❌ | ❌ |
| Edit obligation | ✅ | ✅ | ❌ | ❌ |
| Complete obligation | ✅ | ✅ | ✅ (own) | ❌ |
| Upload documents | ✅ | ✅ | ✅ | ❌ |
| View audit logs | ✅ | ✅ | ❌ | ✅ |
| Generate reports | ✅ | ✅ | ❌ | ✅ |
| Manage users | ✅ | ❌ | ❌ | ❌ |
| Billing | ✅ | ❌ | ❌ | ❌ |

---

## Reminder Engine

Runs daily at 9:00 AM IST via cron (`30 3 * * *` UTC).

**Schedule per obligation:**
- T-30 days: First reminder → Owner
- T-15 days: Second reminder → Owner
- T-7 days: Urgent reminder → Owner
- T-1 day: Final reminder → Owner
- Overdue: Daily → Owner + Escalation Manager

**All reminders are logged immutably in the `reminders` table.** They cannot be edited, deleted, or backdated — this preserves audit integrity.

Manual trigger (admin):
```bash
POST /api/v1/reminders/process-now
Authorization: Bearer {admin_token}
```

---

## Security

- JWT access tokens (15 min) + refresh tokens (7 days)
- RBAC enforced on every endpoint via `RolesGuard`
- Multi-tenant isolation: all queries filter by `company_id`
- **No hard deletes**: all records use soft-delete (`deleted_at`)
- Audit logs are **write-only** — no update/delete permissions granted to app role
- Reminder table is **immutable** (INSERT only in production)
- Razorpay: HMAC-SHA256 signature verification on every payment
- Stripe: Webhook signature verification with `stripe.webhooks.constructEvent`
- HTTPS-only in production (enforce via nginx/load balancer)
- Rate limiting: 60 requests/minute per IP via `ThrottlerModule`

---

## API Documentation

Swagger UI available at `/docs` in development:
- http://localhost:4000/docs

Key endpoints:
```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh

GET    /api/v1/obligations
POST   /api/v1/obligations
GET    /api/v1/obligations/:id
PUT    /api/v1/obligations/:id
PATCH  /api/v1/obligations/:id/complete
DELETE /api/v1/obligations/:id

POST   /api/v1/payments/razorpay/create-order
POST   /api/v1/payments/razorpay/verify
POST   /api/v1/payments/webhook/razorpay
POST   /api/v1/payments/stripe/create-session
POST   /api/v1/payments/webhook/stripe
GET    /api/v1/payments/history

GET    /api/v1/audit-logs
GET    /api/v1/reports
GET    /api/v1/reports/export/pdf
GET    /api/v1/reports/export/excel
```

---

## Production Deployment Checklist

- [ ] Set all environment variables in production
- [ ] Run database migrations: `pnpm migrate`
- [ ] Configure Razorpay webhook URL
- [ ] Configure Stripe webhook URL
- [ ] Enable HTTPS / SSL (nginx reverse proxy)
- [ ] Set up daily backup for PostgreSQL
- [ ] Verify cron job fires at 9 AM IST
- [ ] Test payment flows (Razorpay + Stripe) end-to-end
- [ ] Test multi-tenant isolation (two separate company accounts)
- [ ] Test reminder emails with actual SMTP
- [ ] Enable DB-level INSERT-only on `audit_logs` and `reminders` tables

---

## License

Proprietary — All rights reserved. ObligoTrack © 2025
