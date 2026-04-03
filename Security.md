# ObligoTrack — Security Architecture

## Authentication

### JWT Token Strategy
- **Access Token**: 15-minute expiry, signed with `JWT_SECRET`
- **Refresh Token**: 7-day expiry, signed with `JWT_REFRESH_SECRET` (different secret)
- Tokens contain: `{ sub: userId, email, role, companyId }`
- Refresh tokens are hashed before storage (bcrypt)
- Automatic token rotation on refresh

### Password Security
- Passwords hashed with bcrypt, cost factor 12
- `passwordHash` field excluded from all SELECT queries by default
- Minimum 8 characters enforced at API level

---

## Role-Based Access Control (RBAC)

### Role Hierarchy
```
Admin > Manager > Owner > Auditor
```

### Permission Matrix
| Resource           | Admin | Manager | Owner      | Auditor |
|--------------------|-------|---------|------------|---------|
| Create obligation  | ✅    | ✅      | ❌         | ❌      |
| Edit obligation    | ✅    | ✅      | ❌         | ❌      |
| Complete obligation| ✅    | ✅      | ✅ (own)   | ❌      |
| Upload document    | ✅    | ✅      | ✅         | ❌      |
| View audit logs    | ✅    | ✅      | ❌         | ✅      |
| Generate reports   | ✅    | ✅      | ❌         | ✅      |
| Manage users       | ✅    | ❌      | ❌         | ❌      |
| Configure reminders| ✅    | ❌      | ❌         | ❌      |
| View billing       | ✅    | ❌      | ❌         | ❌      |
| Trigger reminders  | ✅    | ❌      | ❌         | ❌      |

---

## Multi-Tenant Isolation

Every database query is scoped by `company_id`:
- `UsersService.findAll(companyId)` — only users from same company
- `ObligationsService.findAll(query, companyId)` — only company's obligations
- `AuditLogService.findForCompany(companyId)` — only company's logs

**This is enforced at the service layer, not just the controller**, so even if a route guard is bypassed, the data remains isolated.

---

## Data Integrity

### No Hard Deletes
All records use soft-delete:
```typescript
obligation.deletedAt = new Date(); // never: repo.delete(id)
user.isActive = false;             // never: repo.delete(id)
```

### Immutable Records
`reminders` and `audit_logs` tables are INSERT-only:
- No `updatedAt` column on either table
- In production: `REVOKE UPDATE, DELETE ON reminders FROM app_role`
- In production: `REVOKE UPDATE, DELETE ON audit_logs FROM app_role`

### Document Versioning
Documents are never deleted or overwritten:
- New upload supersedes old via `isCurrent = false`
- All versions retained with full history
- `supersededBy` field tracks lineage

---

## Payment Security

### Razorpay
- HMAC-SHA256 signature verification on every payment:
  ```
  expectedSig = HMAC_SHA256(orderId + "|" + paymentId, keySecret)
  ```
- Raw body parsing preserved for webhook signature verification
- Webhook secret separate from API secret

### Stripe
- `stripe.webhooks.constructEvent()` used for webhook verification
- Raw body preserved (not parsed) before verification
- Separate webhook secret per environment

### What is NEVER stored
- Card numbers
- CVV/CVC codes
- UPI PINs
- Bank account credentials
These are handled entirely by Razorpay/Stripe — ObligoTrack only stores gateway-issued IDs.

---

## API Security

### Rate Limiting
- Global: 60 requests / minute / IP (via `ThrottlerModule`)
- Auth endpoints: 5 register attempts / minute, 10 login attempts / minute

### Input Validation
- All DTOs validated with `class-validator`
- `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true`
- Prevents prototype pollution and mass-assignment attacks

### CORS
- Restricted to `FRONTEND_URL` environment variable
- Credentials allowed only from that origin

---

## Production Hardening Checklist

- [ ] Use HTTPS only (SSL at nginx/load balancer level)
- [ ] Set `NODE_ENV=production` (disables Swagger)
- [ ] Rotate `JWT_SECRET` and `JWT_REFRESH_SECRET` on first deploy
- [ ] Set PostgreSQL app role to INSERT-only on `audit_logs` and `reminders`
- [ ] Enable PostgreSQL SSL: `ssl: { rejectUnauthorized: true }`
- [ ] Configure Razorpay IP whitelist for webhooks
- [ ] Configure Stripe webhook endpoint signature
- [ ] Set up automated PostgreSQL backups (daily, 30-day retention)
- [ ] Enable database connection pooling (PgBouncer recommended)
- [ ] Set up monitoring & alerting (e.g., Sentry for errors)
- [ ] Review and trim CORS `allowedOrigins` to production domain only
