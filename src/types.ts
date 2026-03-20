// ── Configuration ────────────────────────────────────────────────────────────

export interface CyncoBillingConfig {
  /** Secret key (cp_sk_...) for server-side operations, or publishable key (cp_pk_...) for client-side. */
  key: string;
  /** API base URL. Defaults to https://app.cynco.io */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 10000. */
  timeout?: number;
  /** API version (YYYY-MM-DD). Defaults to latest. Sent as X-CyncoBilling-Version header. */
  apiVersion?: string;
}

/** Options for individual API requests. */
export interface RequestOptions {
  /** Idempotency key for safe retries. Supported on subscribe, cancel, and updateSubscription. */
  idempotencyKey?: string;
}

// ── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

// ── API Envelope ─────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: { field: string; message: string }[];
}

// ── Core: Subscribe ──────────────────────────────────────────────────────────

export interface SubscribeInput {
  /** External customer ID or inline customer creation. */
  customer: string | { id: string; email: string; name: string };
  /** Product slug to subscribe to. */
  product: string;
  /** Specific price ID when a product has multiple prices. */
  priceId?: string;
  /** Redirect URL after successful checkout. */
  successUrl?: string;
  /** Redirect URL if the customer cancels checkout. */
  cancelUrl?: string;
  /** Quantity for per-unit pricing. */
  quantity?: number;
  /** Coupon code to apply a discount. */
  couponCode?: string;
  /** Device/browser fingerprint for trial abuse prevention. */
  fingerprint?: string;
  /** Day of month (1-28) to anchor billing dates to. First period is prorated. */
  billingAnchorDay?: number;
  /** Arbitrary key-value pairs stored with the subscription. */
  metadata?: Record<string, unknown>;
}

export interface SubscribeResult {
  action: "checkout" | "activated" | "scheduled" | "noop";
  /** Checkout URL — redirect the customer here when action is "checkout". */
  url?: string;
  /** Checkout session ID for tracking. */
  checkoutId?: string;
  /** Subscription details when activated or scheduled. */
  subscription?: SubscriptionSummary;
  /** When the change takes effect (for scheduled downgrades). */
  effectiveAt?: string;
  /** Prorated amount charged on upgrade (in minor units). */
  prorationAmount?: number;
  /** Discount amount applied by coupon (in minor units). */
  discountAmount?: number;
  /** Present when payment couldn't be processed automatically (3DS, card declined). */
  requiredAction?: { code: string; reason: string };
}

// ── Core: Check ──────────────────────────────────────────────────────────────

export interface CheckInput {
  customer: string;
  feature: string;
  /** Atomically check AND deduct in one call. Zero race conditions. */
  sendEvent?: boolean;
  /** Minimum balance required for access. */
  requiredBalance?: number;
  /** Entity ID for per-seat/per-workspace checks. */
  entityId?: string;
  /** Balance lock for reserve-then-confirm pattern. */
  lock?: { enabled: boolean; lockId?: string; expiresAt: number };
}

export interface CheckResult {
  allowed: boolean;
  balance: number | null;
  limit: number | null;
  granted: number | null;
  usage: number | null;
  unlimited: boolean;
  overageAllowed: boolean;
  /** Present when a balance lock was requested. */
  lockId?: string | null;
}

// ── Core: Track ──────────────────────────────────────────────────────────────

export interface TrackInput {
  customer: string;
  feature: string;
  /** Usage amount to record. Defaults to 1. */
  amount?: number;
  /** Entity ID for per-seat/per-workspace tracking. */
  entityId?: string;
  /** Idempotency key to prevent double-counting. */
  idempotencyKey?: string;
  /** Arbitrary metadata stored with the usage event. */
  metadata?: Record<string, unknown>;
}

export interface TrackResult {
  recorded: boolean;
  allowed: boolean;
  balance: number | null;
  limit: number | null;
  unlimited: boolean;
  /** True when this idempotency key was already processed. */
  duplicate: boolean;
  /** True when usage was blocked by a spend cap. */
  spendCapExceeded?: boolean;
}

// ── Core: Cancel ─────────────────────────────────────────────────────────────

export interface CancelInput {
  customer: string;
  /** Product slug. Omit to cancel all subscriptions. */
  product?: string;
  /** Cancel immediately (revoke access now) vs at end of billing period (default). */
  immediate?: boolean;
  /** Cancellation reason for analytics. */
  reason?: string;
}

export interface CancelResult {
  canceled: boolean;
  effectiveAt: string | null;
}

// ── Products ─────────────────────────────────────────────────────────────────

export interface CreateProductInput {
  name: string;
  /** URL-safe identifier. Lowercase alphanumeric, hyphens, underscores. */
  slug: string;
  description?: string;
  /** Auto-assigned to new customers when true. */
  isDefault?: boolean;
  /** Add-on products can be stacked on top of a base plan. */
  isAddOn?: boolean;
  /** Group slug for organizing plans in pricing tables. */
  groupSlug?: string;
  /** Display order in pricing tables. */
  sortOrder?: number;
  metadata?: Record<string, unknown>;
  prices?: PriceInput[];
  features?: FeatureInput[];
}

export interface PriceInput {
  name?: string;
  type: "one_time" | "recurring";
  billingInterval?: "week" | "month" | "year";
  billingIntervalCount?: number;
  /** Price in minor units (cents/sen). e.g. MYR 9.90 = 990 */
  amount: number;
  /** ISO 4217 currency code (3 chars). Defaults to MYR. */
  currency?: string;
  /** Free trial duration in days. */
  trialDays?: number;
  /** Require a payment method to start the trial. */
  trialRequiresCard?: boolean;
  /** One-time setup fee in minor units (cents/sen). */
  setupFee?: number;
}

export interface FeatureInput {
  slug: string;
  name: string;
  type?: "boolean" | "metered" | "credit_system";
  allowanceType?: "boolean" | "fixed" | "unlimited";
  allowance?: number;
  overageAllowed?: boolean;
  /** Per-unit overage price in minor units. */
  overagePrice?: number;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean | null;
  isAddOn: boolean | null;
  groupSlug: string | null;
  sortOrder: number | null;
  status: string | null;
  metadata: Record<string, unknown>;
}

// ── Plans ────────────────────────────────────────────────────────────────────

export interface Plan {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isAddOn: boolean;
  sortOrder: number;
  prices: PlanPrice[];
  features: PlanFeature[];
  customerEligibility: CustomerEligibility | null;
}

export interface PlanPrice {
  id: string;
  amount: number;
  currency: string;
  billingInterval: string | null;
  billingIntervalCount: number | null;
  trialDays: number | null;
  setupFee: number | null;
}

export interface PlanFeature {
  slug: string;
  name: string;
  type: string;
  allowanceType: string;
  allowance: number | null;
  unlimited: boolean;
}

export interface CustomerEligibility {
  scenario: "new" | "upgrade" | "downgrade" | "active" | "scheduled" | "canceled";
  currentSubscriptionId: string | null;
  prorationAmount: number | null;
  trialAvailable: boolean;
}

// ── Customers ────────────────────────────────────────────────────────────────

export interface CreateCustomerInput {
  customerId: string;
  name?: string;
  email?: string;
}

export interface UpdateCustomerInput {
  customerId: string;
  name?: string;
  email?: string;
}

export interface CustomerState {
  id: string;
  externalId: string;
  environment: "live" | "test";
  name: string | null;
  email: string | null;
  subscriptions: SubscriptionSummary[];
  balances: Record<string, CustomerBalance>;
  flags: Record<string, boolean>;
  paymentMethods: PaymentMethod[];
}

export interface CustomerBalance {
  balance: number;
  limit: number | null;
  unlimited: boolean;
}

export interface PaymentMethod {
  id: string;
  type: string;
  last4: string | null;
  brand: string | null;
  expiresAt: string | null;
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export type SubscriptionStatus =
  | "checkout"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "expired"
  | "paused";

export interface SubscriptionSummary {
  id: string;
  status: SubscriptionStatus;
  productSlug: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  quantity: number;
}

export interface UpdateSubscriptionInput {
  customer: string;
  product: string;
  cancelAction?: "cancel_end_of_cycle" | "cancel_immediately" | "uncancel";
  pauseAction?: "pause" | "resume";
  /** ISO datetime for when a paused subscription should auto-resume. */
  resumeAt?: string;
  /** Change subscription seat quantity. Prorated mid-cycle. */
  quantity?: number;
  featureQuantities?: { featureId: string; quantity: number }[];
  prorationBehavior?: "prorate" | "none";
}

export interface UpdateSubscriptionResult {
  updated: boolean;
  action: string;
  subscription?: { id: string; status: string; productSlug: string; quantity: number };
  lineItems?: { title: string; description: string; amount: number }[];
  total?: number;
  refundAmount?: number;
}

// ── Preview ──────────────────────────────────────────────────────────────────

export interface PreviewResult {
  scenario: string;
  amountDue: number;
  lineItems: { title: string; description: string; amount: number }[];
  proration: { creditAmount: number; chargeAmount: number } | null;
  trial: { trialDays: number; trialEnd: string } | null;
  currentPlan: string | null;
  targetPlan: string;
}

// ── Balances ─────────────────────────────────────────────────────────────────

export interface CreateBalanceInput {
  customer: string;
  feature: string;
  grantedBalance: number;
  resetInterval?: "month" | "year" | "one_off";
}

export interface UpdateBalanceInput {
  customer: string;
  feature: string;
  /** Set usage directly. Mutually exclusive with `balance`. */
  usage?: number;
  /** Set balance directly. Mutually exclusive with `usage`. */
  balance?: number;
}

export interface FinalizeLockInput {
  lockId: string;
  action: "confirm" | "release";
  /** Actual consumption — unused tokens from the reservation are refunded. */
  overrideValue?: number;
}

export interface FinalizeLockResult {
  success: boolean;
  adjusted: number;
}

// ── Entities ─────────────────────────────────────────────────────────────────

export interface CreateEntityInput {
  customer: string;
  /** Your external ID for the seat/workspace/project. */
  entityId: string;
  /** Feature slug this entity counts toward (e.g. "seats"). */
  featureId: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface Entity {
  id: string;
  customerId: string;
  entityId: string;
  featureId: string;
  name: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ── Coupons ──────────────────────────────────────────────────────────────────

export interface CreateCouponInput {
  /** Unique coupon code customers will enter. */
  code: string;
  name?: string;
  /** Discount type. "trial_extension" extends the trial period instead of discounting price. */
  type: "percentage" | "fixed" | "trial_extension";
  /** Discount value. For percentage: 1-100. For fixed: amount in minor units. For trial_extension: days. */
  value: number;
  duration: "once" | "repeating" | "forever";
  /** Required when duration is "repeating". Number of billing cycles the discount applies. */
  durationMonths?: number;
  maxRedemptions?: number;
  /** Per-customer redemption limit. Defaults to 1. */
  maxRedemptionsPerCustomer?: number;
  /** Minimum order amount in minor units for the coupon to apply. */
  minimumAmount?: number;
  /** Restrict coupon to specific product IDs. */
  productIds?: string[];
  /** ISO datetime — coupon is not valid before this date. */
  validFrom?: string;
  /** ISO datetime — coupon expires after this date. */
  validUntil?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateCouponInput {
  name?: string;
  status?: "active" | "archived";
  maxRedemptions?: number | null;
  maxRedemptionsPerCustomer?: number;
  validUntil?: string | null;
  metadata?: Record<string, unknown>;
}

export interface Coupon {
  id: string;
  code: string;
  name: string | null;
  type: "percentage" | "fixed" | "trial_extension";
  value: number;
  duration: "once" | "repeating" | "forever";
  durationMonths: number | null;
  redemptionCount: number;
  maxRedemptions: number | null;
  maxRedemptionsPerCustomer: number;
  status: "active" | "archived" | null;
  validFrom: string | null;
  validUntil: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface CouponValidation {
  valid: boolean;
  /** Reason when valid is false. */
  message?: string;
  /** Discount amount in minor units when valid is true. */
  discountAmount?: number;
  /** Final amount after discount in minor units when valid is true. */
  finalAmount?: number;
  couponType?: string;
  duration?: string;
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

export interface CreateWebhookInput {
  url: string;
  /** Event types to receive. Omit for all events. */
  events?: string[];
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  /** Signing secret — only returned once on creation. */
  secret?: string;
  events: string[] | null;
  status: string | null;
}

export type WebhookEventType =
  | "subscription.created"
  | "subscription.activated"
  | "subscription.renewed"
  | "subscription.upgraded"
  | "subscription.downgraded"
  | "subscription.updated"
  | "subscription.canceled"
  | "subscription.expired"
  | "subscription.paused"
  | "subscription.resumed"
  | "payment.succeeded"
  | "payment.failed"
  | "payment.refunded"
  | "invoice.created"
  | "invoice.paid"
  | "entitlement.exhausted"
  | "entitlement.threshold_reached";

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  created: string;
  data: Record<string, unknown>;
}

// ── Spend Caps ───────────────────────────────────────────────────────────────

export interface SpendCapStatus {
  customerId: string;
  featureId: string;
  /** Cap in minor units, or null if no cap set. */
  capCents: number | null;
  /** Accrued overage cost this period in minor units. */
  accruedCents: number;
  /** Remaining before cap is hit, or null if no cap. */
  remainingCents: number | null;
  unlimited: boolean;
}

export interface SetSpendCapInput {
  customer: string;
  feature: string;
  /** Cap in minor units. Pass null to remove the cap. */
  capCents: number | null;
}

export interface SetProductSpendCapInput {
  scope: "product";
  productId: string;
  featureId: string;
  /** Default cap in minor units for all customers on this product. Pass null to remove. */
  capCents: number | null;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface AnalyticsSummary {
  mrr: number;
  arr: number;
  activeSubscriptions: number;
  arpu: number;
  churnRate: number;
  trialConversionRate: number;
}

export interface RevenueTimelineEntry {
  month: string;
  revenue: number;
  newSubscriptions: number;
  churned: number;
}

// ── Usage Events ─────────────────────────────────────────────────────────────

export interface UsageTimelineEntry {
  period: string;
  count: number;
  total: number;
}

export interface UsageAggregation {
  timeline: UsageTimelineEntry[];
  total: { count: number; sum: number };
}

// ── Audit Log ────────────────────────────────────────────────────────────────

export interface AuditEvent {
  id: string;
  event: string;
  actorType: "api" | "system" | "cron";
  customerMapId: string | null;
  subscriptionId: string | null;
  resourceType: "subscription" | "entitlement" | "coupon" | "payment" | null;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

// ── API Keys ─────────────────────────────────────────────────────────────────

export interface CreateApiKeyInput {
  name: string;
  type: "secret" | "publishable";
  environment?: "live" | "test";
}

export interface ApiKey {
  id: string;
  name: string;
  type: "secret" | "publishable";
  keyPrefix: string;
  environment: "live" | "test";
  lastUsedAt: string | null;
  createdAt: string | null;
  status: string;
}

export interface ApiKeyWithRawKey extends ApiKey {
  /** The full API key — shown only once on creation. Store it securely. */
  rawKey: string;
}

// ── Rewards ──────────────────────────────────────────────────────────────────

export interface CreateRewardProgramInput {
  name: string;
  rewardType: "free_product" | "percentage_discount" | "fixed_discount" | "credit";
  /** Reward value. Percentage (1-100), minor units (fixed/credit), or ignored (free_product). */
  rewardValue: number;
  /** Required when rewardType is "free_product". */
  rewardProductId?: string;
  trigger?: "referral_signup" | "referral_subscribe";
  maxRedemptions?: number;
  maxPerReferrer?: number;
  metadata?: Record<string, unknown>;
}

export interface RewardProgram {
  id: string;
  name: string;
  rewardType: string;
  rewardValue: number;
  trigger: string;
  status: string;
  createdAt: string;
}

export interface CreateReferralCodeInput {
  programId: string;
  /** The referrer's external customer ID. */
  customer: string;
  /** Unique referral code. */
  code: string;
  maxRedemptions?: number;
  expiresAt?: string;
}

export interface ReferralCode {
  id: string;
  programId: string;
  code: string;
  customerId: string;
  redemptionCount: number;
  maxRedemptions: number | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface RedeemReferralInput {
  programId: string;
  code: string;
  /** The referee's external customer ID (the one redeeming). */
  customer: string;
}

// ── Pricing Table ────────────────────────────────────────────────────────────

export interface PricingTablePlan {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isAddOn: boolean;
  groupSlug: string | null;
  sortOrder: number;
  prices: PricingTablePrice[];
  features: PricingTableFeature[];
  customerEligibility?: { scenario: string } | null;
}

export interface PricingTablePrice {
  id: string;
  name: string | null;
  amount: number;
  /** Pre-formatted price string (e.g. "MYR 9.90"). */
  amountFormatted: string;
  currency: string;
  billingInterval: string | null;
  billingIntervalCount: number | null;
  trialDays: number;
  setupFee: number | null;
}

export interface PricingTableFeature {
  slug: string;
  name: string;
  type: string;
  allowance: number | null;
  unlimited: boolean;
}

export interface PricingTableResponse {
  plans: PricingTablePlan[];
  groups: { slug: string; planCount: number }[];
}

// ── Product Versions ─────────────────────────────────────────────────────────

export interface ProductVersion {
  id: string;
  productId: string;
  version: number;
  snapshot: Record<string, unknown>;
  createdAt: string;
}
