import type {
  CyncoBillingConfig,
  RequestOptions,
  PaginationParams,
  ApiResponse,
  SubscribeInput,
  SubscribeResult,
  CheckResult,
  TrackResult,
  CancelResult,
  CreateProductInput,
  Product,
  Plan,
  CustomerState,
  SubscriptionStatus,
  UpdateSubscriptionInput,
  UpdateSubscriptionResult,
  PreviewResult,
  CreateBalanceInput,
  UpdateBalanceInput,
  FinalizeLockInput,
  FinalizeLockResult,
  CreateEntityInput,
  Entity,
  SubscriptionSummary,
  CreateWebhookInput,
  WebhookEndpoint,
  CreateCouponInput,
  UpdateCouponInput,
  Coupon,
  CouponValidation,
  SpendCapStatus,
  SetSpendCapInput,
  SetProductSpendCapInput,
  AuditEvent,
  AnalyticsSummary,
  RevenueTimelineEntry,
  UsageAggregation,
  CreateApiKeyInput,
  ApiKey,
  ApiKeyWithRawKey,
  CreateRewardProgramInput,
  RewardProgram,
  CreateReferralCodeInput,
  ReferralCode,
  RedeemReferralInput,
  PricingTableResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://app.cynco.io";
const DEFAULT_TIMEOUT = 10_000;

/**
 * Cynco Billing SDK client.
 *
 * ```ts
 * const pay = new CyncoBilling({ key: "cp_sk_..." });
 *
 * await pay.subscribe({ customer: "user_123", product: "pro", successUrl: "..." });
 * await pay.check("user_123", "api_calls");
 * await pay.track("user_123", "api_calls");
 * await pay.cancel("user_123");
 * ```
 */
export class CyncoBilling {
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly apiVersion: string | undefined;

  constructor(config: CyncoBillingConfig) {
    if (!config.key) {
      throw new Error("CyncoBilling: key is required (cp_sk_... or cp_pk_...)");
    }
    this.key = config.key;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.apiVersion = config.apiVersion;
  }

  // ── Core ───────────────────────────────────────────────────────────────────

  /** Subscribe a customer to a product. Handles new, upgrade, downgrade, and re-subscribe. */
  async subscribe(input: SubscribeInput, options?: RequestOptions): Promise<SubscribeResult> {
    return this.post("/api/v1/pay/subscribe", input, options);
  }

  /**
   * Subscribe a customer to multiple products in one checkout.
   * All products are purchased atomically — if one fails, none are charged.
   *
   * ```ts
   * const result = await pay.multiAttach({
   *   customer: "user_123",
   *   products: [
   *     { product: "pro", quantity: 1 },
   *     { product: "ai_addon", quantity: 1 },
   *   ],
   *   successUrl: "https://app.com/thanks",
   *   cancelUrl: "https://app.com/billing",
   * });
   *
   * if (result.checkoutUrl) redirect(result.checkoutUrl);
   * ```
   */
  async multiAttach(input: {
    customer: string | { id: string; email: string; name: string };
    products: Array<{ product: string; priceId?: string; quantity?: number }>;
    successUrl: string;
    cancelUrl: string;
    couponCode?: string;
    metadata?: Record<string, unknown>;
  }, options?: RequestOptions): Promise<SubscribeResult> {
    return this.post("/api/v1/pay/multi-attach", input, options);
  }

  /**
   * Check if a customer has access to a feature.
   *
   * - Pass `sendEvent: true` to atomically check AND deduct in one call (zero race conditions).
   * - Pass `lock` to reserve tokens with a balance lock (check-with-lock pattern).
   * - Pass `entityId` for per-seat/per-workspace checks.
   */
  async check(customer: string, feature: string, options?: {
    sendEvent?: boolean;
    requiredBalance?: number;
    entityId?: string;
    lock?: { enabled: boolean; lockId?: string; expiresAt: number };
  }): Promise<CheckResult> {
    return this.post("/api/v1/pay/check", { customer, feature, ...options });
  }

  /** Track usage for a metered feature. */
  async track(customer: string, feature: string, options?: {
    amount?: number;
    entityId?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }): Promise<TrackResult> {
    return this.post("/api/v1/pay/track", { customer, feature, ...options });
  }

  /** Cancel a customer's subscription. */
  async cancel(customer: string, options?: {
    product?: string;
    immediate?: boolean;
    reason?: string;
  }, requestOptions?: RequestOptions): Promise<CancelResult> {
    return this.post("/api/v1/pay/cancel", { customer, ...options }, requestOptions);
  }

  /** Finalize a balance lock — confirm usage, release the reservation, or adjust with an override. */
  async finalizeLock(input: FinalizeLockInput): Promise<FinalizeLockResult> {
    return this.post("/api/v1/pay/balances/finalize", input);
  }

  // ── Products ───────────────────────────────────────────────────────────────

  /** List all products. */
  async listProducts(params?: PaginationParams): Promise<Product[]> {
    return this.get("/api/v1/pay/products", params);
  }

  /** Create a product with optional prices and features. */
  async createProduct(input: CreateProductInput): Promise<Product> {
    return this.post("/api/v1/pay/products", input);
  }

  // ── Plans ──────────────────────────────────────────────────────────────────

  /**
   * List all plans. If a customer ID is provided, each plan includes
   * `customerEligibility` (new, upgrade, downgrade, active, scheduled, canceled).
   */
  async listPlans(customer?: string, params?: PaginationParams): Promise<Plan[]> {
    const query = this.buildQuery({ customer, ...params });
    return this.get(`/api/v1/pay/plans${query}`);
  }

  /**
   * Preview what would happen if a customer subscribes to a plan.
   * No charges are made. Returns scenario, amount due, proration, trial info.
   */
  async previewAttach(customer: string, product: string, priceId?: string): Promise<PreviewResult> {
    return this.post("/api/v1/pay/preview", { customer, product, priceId });
  }

  /**
   * Get the embeddable pricing table with pre-formatted prices and plan groups.
   * Safe to call with a publishable key.
   */
  async getPricingTable(customer?: string): Promise<PricingTableResponse> {
    const query = this.buildQuery({ customer });
    return this.get(`/api/v1/pay/components/pricing-table${query}`);
  }

  // ── Product Versions ───────────────────────────────────────────────────────

  /** List product versions (for grandfathering). */
  async listProductVersions(productId: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/pay/products/versions?productId=${encodeURIComponent(productId)}`);
  }

  /** Migrate customers from an old version to the latest product config. */
  async migrateCustomers(productId: string, versionId: string): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/products/versions", { productId, versionId });
  }

  // ── Customers ──────────────────────────────────────────────────────────────

  /**
   * Idempotent get-or-create customer. Returns full state with subscriptions, balances, payment methods.
   * Safe to call on every login/signup.
   */
  async getOrCreateCustomer(input: {
    customerId: string;
    name?: string;
    email?: string;
  }): Promise<CustomerState> {
    return this.post("/api/v1/pay/customers", input);
  }

  /** Get a customer by external ID. Returns subscriptions, balances, payment methods. */
  async getCustomer(externalId: string): Promise<CustomerState> {
    return this.get(`/api/v1/pay/customers?id=${encodeURIComponent(externalId)}`);
  }

  /** List all customers. */
  async listCustomers(params?: PaginationParams): Promise<CustomerState[]> {
    return this.get("/api/v1/pay/customers", params);
  }

  /** Update customer properties (name, email). */
  async updateCustomer(input: {
    customerId: string;
    name?: string;
    email?: string;
  }): Promise<CustomerState> {
    return this.request("PUT", "/api/v1/pay/customers", input);
  }

  /** Delete a customer mapping by external ID. */
  async deleteCustomer(customerId: string): Promise<{ deleted: true }> {
    return this.request("DELETE", `/api/v1/pay/customers?id=${encodeURIComponent(customerId)}`);
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  /** List subscriptions, optionally filtered by comma-separated status values. */
  async listSubscriptions(status?: SubscriptionStatus | (string & {}), params?: PaginationParams): Promise<SubscriptionSummary[]> {
    const query = this.buildQuery({ status, ...params });
    return this.get(`/api/v1/pay/subscriptions${query}`);
  }

  /** Update a subscription — change seat quantity, cancel, uncancel, pause, or resume. */
  async updateSubscription(input: UpdateSubscriptionInput, options?: RequestOptions): Promise<UpdateSubscriptionResult> {
    return this.post("/api/v1/pay/subscriptions/update", input, options);
  }

  /** Preview what a subscription update would charge. No charges are made. */
  async previewUpdate(input: UpdateSubscriptionInput): Promise<UpdateSubscriptionResult> {
    return this.post("/api/v1/pay/subscriptions/preview-update", input);
  }

  // ── Balances ───────────────────────────────────────────────────────────────

  /** Create a standalone balance (promotional credits, rewards). */
  async createBalance(input: CreateBalanceInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/balances/create", input);
  }

  /** Set usage directly or update balance for a feature. Exactly one of `usage` or `balance` must be set. */
  async updateBalance(input: UpdateBalanceInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/balances/update", input);
  }

  // ── Entities ───────────────────────────────────────────────────────────────

  /** Create an entity (seat, workspace, project) under a customer. Auto-increments the feature count. */
  async createEntity(input: CreateEntityInput): Promise<Entity> {
    return this.post("/api/v1/pay/entities", input);
  }

  /** List entities for a customer. */
  async listEntities(customer: string, params?: PaginationParams): Promise<Entity[]> {
    const query = this.buildQuery({ customer, ...params });
    return this.get(`/api/v1/pay/entities${query}`);
  }

  /** Delete an entity. Auto-decrements the feature count. */
  async deleteEntity(customer: string, entityId: string): Promise<Record<string, unknown>> {
    return this.request("DELETE", "/api/v1/pay/entities", { customer, entityId });
  }

  // ── Portal ─────────────────────────────────────────────────────────────────

  /** Generate a customer billing portal URL (signed, 1-hour TTL). */
  async portal(customer: string): Promise<{ url: string }> {
    return this.get(`/api/v1/pay/portal?customer=${encodeURIComponent(customer)}`);
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  /** Get billing analytics (MRR, ARR, churn, ARPU, trial conversion). */
  async analytics(): Promise<AnalyticsSummary> {
    return this.get("/api/v1/pay/analytics");
  }

  /** Get monthly revenue timeline for charts. */
  async revenueTimeline(months?: number): Promise<RevenueTimelineEntry[]> {
    const query = this.buildQuery({ view: "timeline", months });
    return this.get(`/api/v1/pay/analytics${query}`);
  }

  // ── Usage Events ───────────────────────────────────────────────────────────

  /**
   * Aggregate usage events over time. Returns a timeline + totals.
   * Pass to a charting library like Recharts.
   */
  async aggregateEvents(customer: string, feature: string, options?: {
    range?: "7d" | "14d" | "30d" | "90d" | "365d";
    groupBy?: "day" | "week" | "month";
  }): Promise<UsageAggregation> {
    return this.post("/api/v1/pay/events", { customer, feature, ...options });
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  /** Register a webhook endpoint. Returns the signing secret once — store it securely. */
  async createWebhook(input: CreateWebhookInput): Promise<WebhookEndpoint> {
    return this.post("/api/v1/pay/webhooks", input);
  }

  /** List webhook endpoints (secrets are redacted). */
  async listWebhooks(params?: PaginationParams): Promise<WebhookEndpoint[]> {
    return this.get("/api/v1/pay/webhooks", params);
  }

  /** Delete a webhook endpoint. */
  async deleteWebhook(id: string): Promise<{ deleted: true }> {
    return this.request("DELETE", `/api/v1/pay/webhooks?id=${encodeURIComponent(id)}`);
  }

  // ── Coupons ────────────────────────────────────────────────────────────────

  /** Create a coupon. */
  async createCoupon(input: CreateCouponInput): Promise<Coupon> {
    return this.post("/api/v1/pay/coupons", input);
  }

  /** List all coupons. */
  async listCoupons(params?: PaginationParams): Promise<Coupon[]> {
    return this.get("/api/v1/pay/coupons", params);
  }

  /** Get a coupon by ID. */
  async getCoupon(id: string): Promise<Coupon> {
    return this.get(`/api/v1/pay/coupons/${encodeURIComponent(id)}`);
  }

  /** Update a coupon (name, status, limits, expiry). */
  async updateCoupon(id: string, input: UpdateCouponInput): Promise<Coupon> {
    return this.request("PATCH", `/api/v1/pay/coupons/${encodeURIComponent(id)}`, input);
  }

  /** Archive a coupon (soft-delete). */
  async archiveCoupon(id: string): Promise<{ archived: true }> {
    return this.request("DELETE", `/api/v1/pay/coupons/${encodeURIComponent(id)}`);
  }

  /** Validate a coupon code for a customer + product. Safe with publishable key. */
  async validateCoupon(input: {
    code: string;
    customer: string;
    product: string;
    /** Order amount in minor units for minimum-amount checks. */
    amount: number;
  }): Promise<CouponValidation> {
    return this.post("/api/v1/pay/coupons/validate", input);
  }

  // ── Spend Caps ─────────────────────────────────────────────────────────────

  /** Get spend cap status for a customer + feature. */
  async getSpendCap(customer: string, feature: string): Promise<SpendCapStatus> {
    const query = this.buildQuery({ customer, feature });
    return this.get(`/api/v1/pay/spend-caps${query}`);
  }

  /** Set a spend cap for a customer + feature. Pass `capCents: null` to remove. */
  async setSpendCap(input: SetSpendCapInput): Promise<SpendCapStatus> {
    return this.post("/api/v1/pay/spend-caps", input);
  }

  /** Set a default spend cap for all customers on a product + feature. */
  async setProductSpendCap(input: Omit<SetProductSpendCapInput, "scope">): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/spend-caps", { scope: "product", ...input });
  }

  // ── Audit Log ──────────────────────────────────────────────────────────────

  /** List audit events. Filter by subscription, customer, or event type. */
  async listAuditEvents(filters?: {
    subscriptionId?: string;
    customerMapId?: string;
    event?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditEvent[]> {
    const query = this.buildQuery({
      subscription: filters?.subscriptionId,
      customer_map_id: filters?.customerMapId,
      event: filters?.event,
      limit: filters?.limit,
      offset: filters?.offset,
    });
    return this.get(`/api/v1/pay/audit${query}`);
  }

  // ── API Keys ───────────────────────────────────────────────────────────────

  /** Create an API key. The raw key is returned once — store it securely. */
  async createApiKey(input: CreateApiKeyInput): Promise<ApiKeyWithRawKey> {
    return this.post("/api/v1/pay/api-keys", input);
  }

  /** List API keys (raw key values are not included). */
  async listApiKeys(params?: PaginationParams): Promise<ApiKey[]> {
    return this.get("/api/v1/pay/api-keys", params);
  }

  /** Revoke an API key. */
  async revokeApiKey(id: string): Promise<{ revoked: true }> {
    return this.request("DELETE", `/api/v1/pay/api-keys?id=${encodeURIComponent(id)}`);
  }

  // ── Rewards ────────────────────────────────────────────────────────────────

  /** Create a reward program. */
  async createRewardProgram(input: CreateRewardProgramInput): Promise<RewardProgram> {
    return this.post("/api/v1/pay/rewards", input);
  }

  /** List all reward programs. */
  async listRewardPrograms(): Promise<RewardProgram[]> {
    return this.get("/api/v1/pay/rewards");
  }

  /** Create a referral code for a customer. */
  async createReferralCode(input: CreateReferralCodeInput): Promise<ReferralCode> {
    return this.post("/api/v1/pay/rewards?action=code", input);
  }

  /** List referral codes for a customer. */
  async listReferralCodes(customer: string): Promise<ReferralCode[]> {
    return this.get(`/api/v1/pay/rewards?customer=${encodeURIComponent(customer)}`);
  }

  /** Redeem a referral code. Atomic — rewards both referrer and referee. */
  async redeemReferralCode(input: RedeemReferralInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/rewards?action=redeem", input);
  }

  // ── HTTP Layer ─────────────────────────────────────────────────────────────

  private buildQuery(params?: Record<string, string | number | undefined>): string {
    if (!params) return "";
    const entries = Object.entries(params).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    );
    if (entries.length === 0) return "";
    const qs = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
    return `?${qs.toString()}`;
  }

  private async get<T>(path: string, params?: PaginationParams): Promise<T> {
    if (params) {
      const query = this.buildQuery(params as Record<string, string | number | undefined>);
      if (query) {
        path = path.includes("?")
          ? `${path}&${query.slice(1)}`
          : `${path}${query}`;
      }
    }
    return this.request("GET", path);
  }

  private async post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request("POST", path, body, options);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      Accept: "application/json",
    };

    if (this.apiVersion) {
      headers["X-CyncoBilling-Version"] = this.apiVersion;
    }

    if (options?.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null) as ApiResponse<never> | null;
      const message = errorBody?.error?.message ?? `HTTP ${response.status}`;
      const code = errorBody?.error?.code ?? "REQUEST_FAILED";
      throw new CyncoBillingError(message, code, response.status, errorBody?.error?.details);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    const json = await response.json() as ApiResponse<T>;

    // Some list endpoints return { data: [...], pagination: {...} } without success wrapper
    if ("data" in json && !("success" in json)) {
      return (json as { data: T }).data;
    }

    if (json.success === false) {
      throw new CyncoBillingError(
        json.error?.message ?? "Unknown error",
        json.error?.code ?? "UNKNOWN",
        response.status,
        json.error?.details,
      );
    }

    if (json.data === undefined) {
      throw new CyncoBillingError("Empty response from server", "EMPTY_RESPONSE", response.status);
    }

    return json.data;
  }
}

/**
 * Error thrown by the Cynco Billing SDK.
 * Contains the error code and optional field-level validation details.
 */
export class CyncoBillingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = "CyncoBillingError";
  }
}
