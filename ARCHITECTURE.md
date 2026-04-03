# ObligoTrack — Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Browser / Client                      │
│              Next.js 14 (App Router)                    │
│         React Query + Axios + Tailwind CSS              │
└────────────────────┬────────────────────────────────────┘
                     │ HTTPS / REST
┌────────────────────▼────────────────────────────────────┐
│                  NestJS API (Port 4000)                  │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │   Auth   │ │Obligations│ │Reminders │ │Payments  │  │
│  │  Module  │ │  Module  │ │  Module  │ │  Module  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │Documents │ │AuditLogs │ │ Reports  │ │  Users   │  │
│  │  Module  │ │  Module  │ │  Module  │ │  Module  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Scheduler (Cron — 9AM IST daily)        │   │
│  │  Check obligations → Send reminders → Escalate   │   │
│  └──────────────────────────────────────────────────┘   │
└────────┬────────────────┬───────────────────────────────┘
         │                │
┌────────▼───────┐  ┌─────▼──────────────────────────────┐
│  PostgreSQL 16 │  │         External Services            │
│                │  │  ┌──────────┐  ┌──────────────────┐ │
│  companies     │  │  │Razorpay  │  │     Stripe        │ │
│  users         │  │  │(UPI/Card)│  │  (Intl Cards)     │ │
│  obligations   │  │  └──────────┘  └──────────────────┘ │
│  documents     │  │  ┌─────────────────────────────────┐ │
│  reminders*    │  │  │      SMTP Email Service          │ │
│  audit_logs*   │  │  │   (Nodemailer / SendGrid)        │ │
│  payments      │  │  └─────────────────────────────────┘ │
└────────────────┘  └────────────────────────────────────┘
  * = INSERT-only

```

## Key Design Decisions

### 1. Multi-Tenant by `company_id`
Every table has `company_id`. Every service method accepts and filters by `companyId`. This is a **defense-in-depth** approach — even if RBAC is bypassed, cross-company data leakage is impossible because the data layer always scopes queries.

### 2. Immutable Audit Records
`audit_logs` and `reminders` have no `updatedAt` column. In production, the DB role used by the app has `UPDATE` and `DELETE` revoked on these tables. This guarantees tamper-proof audit trails even if the application is compromised.

### 3. Soft Deletes Everywhere
`obligations` use `deletedAt` (soft delete). `users` use `isActive = false`. No compliance record is ever truly deleted. This satisfies regulatory requirements where records must be retained even after deactivation.

### 4. Document Versioning
When a new document is uploaded for an obligation:
1. All existing `isCurrent = true` documents are set to `isCurrent = false`
2. New document is saved with `version = max(previous) + 1` and `isCurrent = true`
3. Old versions remain fully accessible — nothing is overwritten or deleted

### 5. Payment Flow Resilience
Two paths ensure subscription activation even if browser closes mid-payment:

**Primary (client-side):** User completes payment → client calls `/payments/razorpay/verify` → signature verified → subscription activated

**Fallback (webhook):** Razorpay/Stripe sends server-to-server webhook → backend verifies signature → subscription activated

Both paths log to `audit_logs` and send confirmation email.

### 6. Reminder Engine Design
The cron scheduler (`3:30 UTC = 9:00 AM IST`) runs daily and:
- Checks **all** active non-completed obligations
- Sends reminders only if not already sent today (idempotent)
- Updates `status` field on all obligations (upcoming → due → overdue)
- Logs every send attempt (success or failure) to `reminders` table
- Cannot be retroactively modified

## Data Flow: Obligation Lifecycle

```
Create (admin/manager)
  │
  ▼
status = 'upcoming'
  │
  │ [T-30 days] → reminder email → owner
  │ [T-15 days] → reminder email → owner
  │ [T-7 days]  → reminder email → owner
  │ [T-1 day]   → reminder email → owner
  │
  ▼ [past due date]
status = 'overdue'
  │
  │ [daily]     → escalation email → owner + manager
  │
  └──► Owner uploads proof + marks complete
         │
         ▼
       status = 'completed'
       completedAt = NOW()
       completedBy = userId
         │
         ▼
       [if renewalFrequency != 'one_time']
       Next instance created with new dueDate
```
