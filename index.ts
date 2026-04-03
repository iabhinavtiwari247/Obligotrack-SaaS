// packages/shared/src/types/audit.ts

export type AuditAction =
  | 'user.login'
  | 'user.logout'
  | 'user.created'
  | 'user.updated'
  | 'user.deactivated'
  | 'obligation.created'
  | 'obligation.updated'
  | 'obligation.completed'
  | 'obligation.reactivated'
  | 'document.uploaded'
  | 'document.superseded'
  | 'reminder.sent'
  | 'reminder.escalated'
  | 'report.generated'
  | 'payment.initiated'
  | 'payment.success'
  | 'payment.failed'
  | 'subscription.activated'
  | 'subscription.expired';

export interface AuditLog {
  id: string;
  companyId: string;
  userId: string;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
  user?: {
    firstName: string;
    lastName: string;
    email: string;
  };
}

// packages/shared/src/types/payment.ts
export type SubscriptionPlan = 'monthly' | 'half_yearly' | 'yearly';
export type PaymentGateway = 'razorpay' | 'stripe';
export type PaymentStatus = 'pending' | 'success' | 'failed' | 'refunded';
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';

export const PLAN_PRICES = {
  monthly: { amount: 600000, label: '₹6,000/month', months: 1 },        // in paise
  half_yearly: { amount: 3250000, label: '₹32,500/6 months', months: 6 },
  yearly: { amount: 6500000, label: '₹65,000/year', months: 12 },
} as const;

export const PLAN_SAVINGS = {
  monthly: null,
  half_yearly: '₹3,500',
  yearly: '₹7,000',
} as const;

export interface Payment {
  id: string;
  companyId: string;
  userId: string;
  gateway: PaymentGateway;
  gatewayOrderId: string;
  gatewayPaymentId?: string;
  plan: SubscriptionPlan;
  amount: number;
  currency: string;
  status: PaymentStatus;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Company {
  id: string;
  name: string;
  industry: string;
  timezone: string;
  subscriptionStatus: SubscriptionStatus;
  subscriptionPlan?: SubscriptionPlan;
  subscriptionExpiresAt?: string;
  createdAt: string;
}
