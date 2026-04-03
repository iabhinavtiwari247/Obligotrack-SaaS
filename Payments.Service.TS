import {
  Injectable, BadRequestException, Logger, NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';
import Stripe from 'stripe';
import { Payment, PLAN_CONFIG } from './payment.entity';
import { Company } from '../companies/company.entity';
import { User } from '../users/user.entity';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateRazorpayOrderDto,
  VerifyRazorpayPaymentDto,
  CreateStripeSessionDto,
} from './payment.dto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private razorpay: Razorpay;
  private stripe: Stripe;

  constructor(
    @InjectRepository(Payment)
    private paymentsRepo: Repository<Payment>,
    @InjectRepository(Company)
    private companiesRepo: Repository<Company>,
    private configService: ConfigService,
    private auditLogService: AuditLogService,
    private notificationsService: NotificationsService,
  ) {
    this.razorpay = new Razorpay({
      key_id: this.configService.get<string>('RAZORPAY_KEY_ID'),
      key_secret: this.configService.get<string>('RAZORPAY_KEY_SECRET'),
    });

    this.stripe = new Stripe(
      this.configService.get<string>('STRIPE_SECRET_KEY'),
      { apiVersion: '2023-10-16' },
    );
  }

  // ─── RAZORPAY ─────────────────────────────────────────────────────────────

  async createRazorpayOrder(dto: CreateRazorpayOrderDto, actor: User) {
    const config = PLAN_CONFIG[dto.plan];

    // Create Razorpay order
    const order = await this.razorpay.orders.create({
      amount: config.amountPaise,
      currency: 'INR',
      receipt: `obligotrack_${actor.companyId}_${Date.now()}`,
      notes: {
        companyId: actor.companyId,
        userId: actor.id,
        plan: dto.plan,
      },
    });

    // Persist pending payment record
    const payment = this.paymentsRepo.create({
      companyId: actor.companyId,
      userId: actor.id,
      gateway: 'razorpay',
      gatewayOrderId: order.id,
      plan: dto.plan,
      amount: config.amountPaise,
      currency: 'INR',
      status: 'pending',
    });
    await this.paymentsRepo.save(payment);

    await this.auditLogService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'payment.initiated',
      entityType: 'payment',
      entityId: payment.id,
      metadata: { gateway: 'razorpay', plan: dto.plan, orderId: order.id },
    });

    return {
      orderId: order.id,
      amount: config.amountPaise,
      currency: 'INR',
      keyId: this.configService.get<string>('RAZORPAY_KEY_ID'),
      plan: dto.plan,
      planLabel: config.label,
      paymentId: payment.id,
    };
  }

  async verifyRazorpayPayment(dto: VerifyRazorpayPaymentDto, actor: User) {
    // 1. Verify signature (HMAC SHA256)
    const secret = this.configService.get<string>('RAZORPAY_KEY_SECRET');
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${dto.razorpay_order_id}|${dto.razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== dto.razorpay_signature) {
      this.logger.warn(`Signature mismatch for order ${dto.razorpay_order_id}`);
      throw new BadRequestException('Payment verification failed: invalid signature');
    }

    // 2. Find the pending payment record
    const payment = await this.paymentsRepo.findOne({
      where: { gatewayOrderId: dto.razorpay_order_id, companyId: actor.companyId },
    });
    if (!payment) throw new NotFoundException('Payment record not found');

    // 3. Mark payment as successful
    payment.gatewayPaymentId = dto.razorpay_payment_id;
    payment.gatewaySignature = dto.razorpay_signature;
    payment.status = 'success';
    const { startsAt, endsAt } = this.calculateSubscriptionPeriod(dto.plan);
    payment.subscriptionStartsAt = startsAt;
    payment.subscriptionEndsAt = endsAt;
    await this.paymentsRepo.save(payment);

    // 4. Activate subscription
    await this.activateSubscription(actor.companyId, dto.plan, startsAt, endsAt);

    // 5. Send confirmation email
    await this.notificationsService.sendPaymentConfirmationEmail({
      to: actor.email,
      recipientName: `${actor.firstName} ${actor.lastName}`,
      plan: dto.plan,
      amount: `₹${PLAN_CONFIG[dto.plan].amountPaise / 100}`,
      validUntil: endsAt.toLocaleDateString('en-IN'),
      paymentId: dto.razorpay_payment_id,
    });

    await this.auditLogService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'payment.success',
      entityType: 'payment',
      entityId: payment.id,
      metadata: {
        gateway: 'razorpay',
        paymentId: dto.razorpay_payment_id,
        plan: dto.plan,
        amount: payment.amount,
      },
    });

    return {
      success: true,
      message: 'Payment verified. Subscription activated.',
      subscriptionExpiresAt: endsAt,
    };
  }

  async handleRazorpayWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const webhookSecret = this.configService.get<string>('RAZORPAY_WEBHOOK_SECRET');
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (expectedSignature !== signature) {
      this.logger.warn('Invalid Razorpay webhook signature');
      return; // Silently ignore — don't throw, prevents retry loops
    }

    const event = JSON.parse(rawBody.toString());
    this.logger.log(`Razorpay webhook: ${event.event}`);

    if (event.event === 'payment.failed') {
      const orderId = event.payload?.payment?.entity?.order_id;
      if (orderId) {
        const payment = await this.paymentsRepo.findOne({
          where: { gatewayOrderId: orderId },
        });
        if (payment) {
          payment.status = 'failed';
          payment.failureReason = event.payload?.payment?.entity?.error_description;
          payment.webhookPayload = event;
          await this.paymentsRepo.save(payment);

          await this.auditLogService.log({
            companyId: payment.companyId,
            userId: payment.userId,
            action: 'payment.failed',
            entityType: 'payment',
            entityId: payment.id,
            metadata: { reason: payment.failureReason },
          });
        }
      }
    }
  }

  // ─── STRIPE ───────────────────────────────────────────────────────────────

  async createStripeCheckoutSession(dto: CreateStripeSessionDto, actor: User) {
    const config = PLAN_CONFIG[dto.plan];
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');

    // Create pending payment record first
    const payment = this.paymentsRepo.create({
      companyId: actor.companyId,
      userId: actor.id,
      gateway: 'stripe',
      gatewayOrderId: `pending_${Date.now()}`, // Will be updated after session creation
      plan: dto.plan,
      amount: config.amountUsd,
      currency: 'USD',
      status: 'pending',
    });
    await this.paymentsRepo.save(payment);

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `ObligoTrack — ${config.label}`,
            description: 'Compliance & Obligation Tracking Platform',
          },
          unit_amount: config.amountUsd,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}&payment_id=${payment.id}`,
      cancel_url: `${frontendUrl}/payment/cancelled`,
      metadata: {
        companyId: actor.companyId,
        userId: actor.id,
        plan: dto.plan,
        paymentId: payment.id,
      },
      customer_email: actor.email,
    });

    // Update order ID with Stripe session ID
    payment.gatewayOrderId = session.id;
    await this.paymentsRepo.save(payment);

    await this.auditLogService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'payment.initiated',
      entityType: 'payment',
      entityId: payment.id,
      metadata: { gateway: 'stripe', plan: dto.plan, sessionId: session.id },
    });

    return {
      sessionId: session.id,
      url: session.url,
      plan: dto.plan,
      planLabel: config.label,
    };
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      this.logger.warn(`Stripe webhook signature verification failed: ${err.message}`);
      return;
    }

    this.logger.log(`Stripe webhook: ${event.type}`);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.CheckoutSession;
      const { companyId, userId, plan, paymentId } = session.metadata;

      const payment = await this.paymentsRepo.findOne({ where: { id: paymentId } });
      if (!payment) {
        this.logger.error(`Payment ${paymentId} not found for Stripe session ${session.id}`);
        return;
      }

      payment.status = 'success';
      payment.gatewayPaymentId = session.payment_intent as string;
      payment.webhookPayload = { sessionId: session.id, paymentIntent: session.payment_intent };
      const { startsAt, endsAt } = this.calculateSubscriptionPeriod(plan as any);
      payment.subscriptionStartsAt = startsAt;
      payment.subscriptionEndsAt = endsAt;
      await this.paymentsRepo.save(payment);

      await this.activateSubscription(companyId, plan as any, startsAt, endsAt);

      // Fetch user to send email
      const user = await this.paymentsRepo.manager.findOne(User, { where: { id: userId } });
      if (user) {
        await this.notificationsService.sendPaymentConfirmationEmail({
          to: user.email,
          recipientName: `${user.firstName} ${user.lastName}`,
          plan: plan as any,
          amount: `$${PLAN_CONFIG[plan].amountUsd / 100}`,
          validUntil: endsAt.toLocaleDateString('en-IN'),
          paymentId: session.payment_intent as string,
        });
      }

      await this.auditLogService.log({
        companyId,
        userId,
        action: 'payment.success',
        entityType: 'payment',
        entityId: payment.id,
        metadata: { gateway: 'stripe', plan, sessionId: session.id },
      });
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object as Stripe.CheckoutSession;
      const { paymentId } = session.metadata;
      if (paymentId) {
        await this.paymentsRepo.update({ id: paymentId }, {
          status: 'failed',
          failureReason: 'Checkout session expired',
          webhookPayload: { sessionId: session.id },
        });
      }
    }
  }

  // ─── SUBSCRIPTION ACTIVATION ──────────────────────────────────────────────

  private async activateSubscription(
    companyId: string,
    plan: 'monthly' | 'half_yearly' | 'yearly',
    startsAt: Date,
    endsAt: Date,
  ): Promise<void> {
    await this.companiesRepo.update({ id: companyId }, {
      subscriptionStatus: 'active',
      subscriptionPlan: plan,
      subscriptionExpiresAt: endsAt,
    });

    await this.auditLogService.log({
      companyId,
      userId: 'system',
      action: 'subscription.activated',
      entityType: 'company',
      entityId: companyId,
      metadata: { plan, startsAt, endsAt },
    });

    this.logger.log(`✅ Subscription activated for company ${companyId}: ${plan} → ${endsAt}`);
  }

  private calculateSubscriptionPeriod(plan: 'monthly' | 'half_yearly' | 'yearly') {
    const startsAt = new Date();
    const endsAt = new Date(startsAt);
    const months = PLAN_CONFIG[plan].months;
    endsAt.setMonth(endsAt.getMonth() + months);
    return { startsAt, endsAt };
  }

  async getPaymentHistory(companyId: string): Promise<Payment[]> {
    return this.paymentsRepo.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
    });
  }
}
