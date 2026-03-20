// ── Configuration ────────────────────────────────────────────────────────────

export interface CyncoPayConfig {
  /** Secret key (cp_sk_...) for server-side operations, or publishable key (cp_pk_...) for client-side. */
  key: string;
  /** API base URL. Defaults to https://app.cynco.io */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 10000. */
  timeout?: number;
}

// ── API Inputs ───────────────────────────────────────────────────────────────

export interface SubscribeInput {
  customer: string | { id: string; email: string; name: string };
  product: string;
  priceId?: string;
  successUrl?: string;
  cancelUrl?: string;
  quantity?: number;
  metadata?: Record<string, unknown>;
  /** "always" forces a checkout redirect even when a stored card exists. */
  redirectMode?: "always" | "if_required";
  /** Carry over unused balances from the old plan on upgrade. */
  carryOverBalances?: { enabled: boolean; featureIds?: string[] };
  /** Carry over accrued usage from the old plan on upgrade. */
  carryOverUsages?: { enabled: boolean; featureIds?: string[] };
}

export interface CheckInput {
  customer: string;
  feature: string;
}

export interface TrackInput {
  customer: string;
  feature: string;
  amount?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CancelInput {
  customer: string;
  product?: string;
  immediate?: boolean;
  reason?: string;
}

export interface ChargeInput {
  customer: string;
  amount: number;
  currency?: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface RefundInput {
  paymentId: string;
  amount?: number;
  reason?: string;
}

export interface CreateProductInput {
  name: string;
  slug: string;
  description?: string;
  isDefault?: boolean;
  isAddOn?: boolean;
  autoEnable?: boolean;
  groupSlug?: string;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
  prices?: PriceInput[];
  features?: FeatureInput[];
}

export interface PriceInput {
  name?: string;
  type: "one_time" | "recurring";
  billingInterval?: "week" | "month" | "quarter" | "semi_annual" | "year";
  billingIntervalCount?: number;
  amount: number;
  currency?: string;
  trialDays?: number;
  trialRequiresCard?: boolean;
  setupFee?: number;
  tiers?: { to: number | "inf"; amount?: number; flatAmount?: number }[];
  tierBehavior?: "graduated" | "volume";
}

export interface FeatureInput {
  slug: string;
  name: string;
  type?: "boolean" | "metered" | "credit_system";
  allowanceType?: "boolean" | "fixed" | "unlimited";
  allowance?: number;
  overageAllowed?: boolean;
  overagePrice?: number;
}

export interface CreateWebhookInput {
  url: string;
  events?: string[];
}

export interface CreateCouponInput {
  code: string;
  name?: string;
  type: "percentage" | "fixed" | "trial_extension";
  value: number;
  duration: "once" | "repeating" | "forever";
  durationMonths?: number;
  maxRedemptions?: number;
  maxRedemptionsPerCustomer?: number;
  minimumAmount?: number;
  productIds?: string[];
  validFrom?: string;
  validUntil?: string;
  metadata?: Record<string, unknown>;
}

export interface SetSpendCapInput {
  customer: string;
  feature: string;
  capCents: number | null;
}

export interface SetProductSpendCapInput {
  productId: string;
  featureId: string;
  capCents: number | null;
  scope: "product";
}

export interface CreateRewardProgramInput {
  name: string;
  rewardType: "free_product" | "percentage_discount" | "fixed_discount" | "credit";
  rewardValue: number;
  rewardProductId?: string;
  trigger?: "referral_signup" | "referral_subscribe";
  maxRedemptions?: number;
  maxPerReferrer?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateReferralCodeInput {
  programId: string;
  customer: string;
  code: string;
  maxRedemptions?: number;
  expiresAt?: string;
}

export interface RedeemReferralInput {
  programId: string;
  code: string;
  customer: string;
}

export interface ValidateCouponInput {
  code: string;
  customer: string;
  product: string;
  amount: number;
}

export interface UpdateCouponInput {
  name?: string;
  status?: "active" | "archived";
  maxRedemptions?: number | null;
  maxRedemptionsPerCustomer?: number;
  validUntil?: string | null;
  metadata?: Record<string, unknown>;
}

// ── API Responses ────────────────────────────────────────────────────────────

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

export interface SubscribeResult {
  action: "checkout" | "activated" | "scheduled" | "noop";
  url?: string;
  checkoutId?: string;
  subscription?: SubscriptionSummary;
  effectiveAt?: string;
  prorationAmount?: number;
  /** Present when payment couldn't be processed automatically (3DS, card declined). */
  requiredAction?: {
    code: string;
    reason: string;
  };
}

export interface CheckResult {
  allowed: boolean;
  balance: number | null;
  limit: number | null;
  granted: number | null;
  usage: number | null;
  unlimited: boolean;
  overageAllowed: boolean;
}

export interface TrackResult {
  recorded: boolean;
  allowed: boolean;
  balance: number | null;
  limit: number | null;
  unlimited: boolean;
  duplicate: boolean;
}

export interface CancelResult {
  canceled: boolean;
  effectiveAt: string | null;
}

export interface SubscriptionSummary {
  id: string;
  status: string;
  productSlug: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  quantity: number;
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

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret?: string;
  events: string[] | null;
  status: string | null;
}

// ── Webhook Events ───────────────────────────────────────────────────────────

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
