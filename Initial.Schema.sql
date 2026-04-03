-- ObligoTrack — Initial Database Schema
-- Run this once to bootstrap the database
-- All tables include company_id for multi-tenant isolation

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── COMPANIES (tenants) ────────────────────────────────────────────────────
CREATE TABLE companies (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                     VARCHAR(200) NOT NULL,
  industry                 VARCHAR(100) NOT NULL,
  timezone                 VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata',
  subscription_status      VARCHAR(50)  NOT NULL DEFAULT 'active',
  subscription_plan        VARCHAR(50),
  subscription_expires_at  TIMESTAMPTZ,
  contact_email            VARCHAR(200),
  contact_phone            VARCHAR(20),
  address                  TEXT,
  reminder_days_t1         INT NOT NULL DEFAULT 30,
  reminder_days_t2         INT NOT NULL DEFAULT 15,
  reminder_days_t3         INT NOT NULL DEFAULT 7,
  reminder_days_t4         INT NOT NULL DEFAULT 1,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── USERS ──────────────────────────────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('admin', 'owner', 'manager', 'auditor');

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  email             VARCHAR(255) NOT NULL UNIQUE,
  password_hash     VARCHAR(500) NOT NULL,
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  role              user_role NOT NULL DEFAULT 'owner',
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at     TIMESTAMPTZ,
  refresh_token_hash VARCHAR(500),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID
);

CREATE INDEX idx_users_company_id ON users(company_id);
CREATE INDEX idx_users_email ON users(email);

-- ── OBLIGATIONS ────────────────────────────────────────────────────────────
CREATE TYPE obligation_type AS ENUM ('license', 'contract', 'statutory', 'internal');
CREATE TYPE obligation_status AS ENUM ('upcoming', 'due', 'overdue', 'completed');
CREATE TYPE renewal_frequency AS ENUM ('one_time', 'monthly', 'quarterly', 'half_yearly', 'yearly');

CREATE TABLE obligations (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            UUID NOT NULL REFERENCES companies(id),
  type                  obligation_type NOT NULL,
  title                 VARCHAR(300) NOT NULL,
  description           TEXT,
  governing_authority   VARCHAR(200),
  due_date              DATE NOT NULL,
  renewal_frequency     renewal_frequency NOT NULL DEFAULT 'yearly',
  grace_period_days     INT NOT NULL DEFAULT 0,
  owner_id              UUID NOT NULL REFERENCES users(id),
  escalation_manager_id UUID NOT NULL REFERENCES users(id),
  status                obligation_status NOT NULL DEFAULT 'upcoming',
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  completed_by          UUID REFERENCES users(id),
  completion_notes      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_obligations_company_id ON obligations(company_id);
CREATE INDEX idx_obligations_status ON obligations(status);
CREATE INDEX idx_obligations_due_date ON obligations(due_date);
CREATE INDEX idx_obligations_owner_id ON obligations(owner_id);
CREATE INDEX idx_obligations_company_status ON obligations(company_id, status);

-- ── DOCUMENTS (proof, immutable history) ──────────────────────────────────
CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id),
  obligation_id   UUID NOT NULL REFERENCES obligations(id),
  file_name       VARCHAR(500) NOT NULL,
  file_size       BIGINT NOT NULL,
  mime_type       VARCHAR(200) NOT NULL,
  storage_key     VARCHAR(1000) NOT NULL,  -- S3 / object storage key
  storage_url     TEXT,
  version         INT NOT NULL DEFAULT 1,
  is_current      BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_by   UUID REFERENCES documents(id),
  uploaded_by     UUID NOT NULL REFERENCES users(id),
  notes           TEXT,
  -- Immutable: no updated_at
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_obligation_id ON documents(obligation_id);
CREATE INDEX idx_documents_company_id ON documents(company_id);

-- ── REMINDERS (immutable audit trail) ─────────────────────────────────────
CREATE TYPE reminder_type AS ENUM ('T-30', 'T-15', 'T-7', 'T-1', 'overdue', 'escalation');
CREATE TYPE reminder_channel AS ENUM ('email', 'sms', 'whatsapp');

CREATE TABLE reminders (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  obligation_id     UUID NOT NULL REFERENCES obligations(id),
  recipient_user_id UUID NOT NULL REFERENCES users(id),
  type              reminder_type NOT NULL,
  channel           reminder_channel NOT NULL DEFAULT 'email',
  delivered         BOOLEAN NOT NULL DEFAULT FALSE,
  failure_reason    TEXT,
  metadata          JSONB,
  -- Immutable: no updated_at
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reminders_obligation_id ON reminders(obligation_id);
CREATE INDEX idx_reminders_company_id ON reminders(company_id);
CREATE INDEX idx_reminders_sent_at ON reminders(sent_at);

-- ── PAYMENTS ───────────────────────────────────────────────────────────────
CREATE TYPE payment_gateway AS ENUM ('razorpay', 'stripe');
CREATE TYPE payment_status AS ENUM ('pending', 'success', 'failed', 'refunded');
CREATE TYPE subscription_plan AS ENUM ('monthly', 'half_yearly', 'yearly');

CREATE TABLE payments (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            UUID NOT NULL REFERENCES companies(id),
  user_id               UUID NOT NULL REFERENCES users(id),
  gateway               payment_gateway NOT NULL,
  gateway_order_id      VARCHAR(200) NOT NULL,
  gateway_payment_id    VARCHAR(200),
  gateway_signature     VARCHAR(500),
  plan                  subscription_plan NOT NULL,
  amount                BIGINT NOT NULL,   -- smallest unit (paise/cents)
  currency              CHAR(3) NOT NULL DEFAULT 'INR',
  status                payment_status NOT NULL DEFAULT 'pending',
  subscription_starts_at TIMESTAMPTZ,
  subscription_ends_at   TIMESTAMPTZ,
  webhook_payload       JSONB,
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_company_id ON payments(company_id);
CREATE INDEX idx_payments_gateway_order_id ON payments(gateway_order_id);
CREATE INDEX idx_payments_status ON payments(status);

-- ── AUDIT LOGS (immutable) ─────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id   UUID NOT NULL,   -- No FK: logs survive company deletion
  user_id      VARCHAR(36) NOT NULL,  -- VARCHAR: 'system' or UUID
  action       VARCHAR(100) NOT NULL,
  entity_type  VARCHAR(100),
  entity_id    VARCHAR(36),
  metadata     JSONB,
  ip_address   VARCHAR(45),
  user_agent   VARCHAR(500),
  -- Immutable: no updated_at
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_company_id ON audit_logs(company_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- ── REVOKE UPDATE/DELETE on audit tables ──────────────────────────────────
-- Run this in production with a restricted role:
-- REVOKE UPDATE, DELETE ON reminders FROM obligotrack_app;
-- REVOKE UPDATE, DELETE ON audit_logs FROM obligotrack_app;

-- ── UPDATE TIMESTAMP TRIGGER ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_obligations_updated_at BEFORE UPDATE ON obligations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
