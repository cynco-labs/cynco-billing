import type {
  CyncoPayConfig,
  ApiResponse,
  SubscribeInput,
  SubscribeResult,
  CheckInput,
  CheckResult,
  TrackInput,
  TrackResult,
  CancelInput,
  CancelResult,
  CreateProductInput,
  Product,
  CreateWebhookInput,
  WebhookEndpoint,
  CreateCouponInput,
  ValidateCouponInput,
  UpdateCouponInput,
  SetSpendCapInput,
  SetProductSpendCapInput,
  CreateRewardProgramInput,
  CreateReferralCodeInput,
  RedeemReferralInput,
} from "./types.js";

const DEFAULT_BASE_URL = "https://app.cynco.io";
const DEFAULT_TIMEOUT = 10_000;

/**
 * Cynco Pay SDK client.
 *
 * ```ts
 * const pay = new CyncoPay({ key: "cp_sk_..." });
 *
 * await pay.subscribe({ customer: "user_123", product: "pro", successUrl: "..." });
 * await pay.check("user_123", "api_calls");
 * await pay.track("user_123", "api_calls");
 * await pay.cancel("user_123");
 * ```
 */
export class CyncoPay {
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(config: CyncoPayConfig) {
    if (!config.key) {
      throw new Error("CyncoPay: key is required (cp_sk_... or cp_pk_...)");
    }
    this.key = config.key;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }

  // ── Core API ─────────────────────────────────────────────────────────────

  /** Subscribe a customer to a product. Handles new, upgrade, downgrade, and re-subscribe. */
  async subscribe(input: SubscribeInput): Promise<SubscribeResult> {
    return this.post("/api/v1/pay/subscribe", input);
  }

  /**
   * Check if a customer has access to a feature.
   * Pass `sendEvent: true` to atomically check AND deduct in one call (zero race conditions).
   * Pass `lock` to reserve tokens with a balance lock (check-with-lock pattern).
   */
  async check(customer: string, feature: string, options?: {
    sendEvent?: boolean;
    requiredBalance?: number;
    entityId?: string;
    lock?: { enabled: boolean; lockId?: string; expiresAt: number };
  }): Promise<CheckResult & { lockId?: string | null }> {
    return this.post("/api/v1/pay/check", { customer, feature, ...options });
  }

  /** Finalize a balance lock — confirm usage, release the reservation, or adjust with an override. */
  async finalizeLock(input: {
    lockId: string;
    action: "confirm" | "release";
    overrideValue?: number;
  }): Promise<{ success: boolean; adjusted: number }> {
    return this.post("/api/v1/pay/balances/finalize", input);
  }

  /** Track usage for a metered feature. */
  async track(customer: string, feature: string, options?: {
    amount?: number;
    entityId?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }): Promise<TrackResult> {
    return this.post("/api/v1/pay/track", {
      customer,
      feature,
      ...options,
    });
  }

  /** Cancel a customer's subscription. */
  async cancel(customer: string, options?: {
    product?: string;
    immediate?: boolean;
    reason?: string;
  }): Promise<CancelResult> {
    return this.post("/api/v1/pay/cancel", { customer, ...options });
  }

  // ── Products ─────────────────────────────────────────────────────────────

  /** List all products. */
  async listProducts(): Promise<Product[]> {
    return this.get("/api/v1/pay/products");
  }

  /** Create a product with optional prices and features. */
  async createProduct(input: CreateProductInput): Promise<Product> {
    return this.post("/api/v1/pay/products", input);
  }

  // ── Product Versions (grandfathering) ──────────────────────────────────

  /** List product versions (for grandfathering). */
  async listProductVersions(productId: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/pay/products/versions?productId=${encodeURIComponent(productId)}`);
  }

  /** Migrate customers from an old version to the latest product config. */
  async migrateCustomers(productId: string, versionId: string): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/products/versions", { productId, versionId });
  }

  // ── Plans ───────────────────────────────────────────────────────────────

  /**
   * List all plans. If a customer ID is provided, each plan includes
   * `customerEligibility` (new, upgrade, downgrade, active, scheduled, canceled).
   */
  async listPlans(customer?: string): Promise<unknown[]> {
    const query = customer ? `?customer=${encodeURIComponent(customer)}` : "";
    return this.get(`/api/v1/pay/plans${query}`);
  }

  /**
   * Preview what would happen if a customer subscribes to a plan.
   * No charges are made. Returns scenario, amount due, proration, trial info.
   */
  async previewAttach(customer: string, product: string, priceId?: string): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/preview", { customer, product, priceId });
  }

  // ── Subscription Updates ─────────────────────────────────────────────────

  /** Update a subscription — change quantities, cancel, or uncancel. */
  async updateSubscription(input: {
    customer: string;
    product: string;
    cancelAction?: "cancel_end_of_cycle" | "cancel_immediately" | "uncancel";
    featureQuantities?: { featureId: string; quantity: number }[];
    prorationBehavior?: "prorate" | "none";
  }): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/subscriptions/update", input);
  }

  /** Preview what a subscription update would charge. */
  async previewUpdate(input: {
    customer: string;
    product: string;
    cancelAction?: "cancel_end_of_cycle" | "cancel_immediately" | "uncancel";
    featureQuantities?: { featureId: string; quantity: number }[];
    prorationBehavior?: "prorate" | "none";
  }): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/subscriptions/preview-update", input);
  }

  // ── Events ─────────────────────────────────────────────────────────────

  /**
   * Aggregate usage events over time. Returns a timeline + totals.
   * Pass to a charting library like Recharts.
   */
  async aggregateEvents(customer: string, feature: string, options?: {
    range?: "7d" | "14d" | "30d" | "90d" | "365d";
    groupBy?: "day" | "week" | "month";
  }): Promise<{ timeline: { period: string; count: number; total: number }[]; total: { count: number; sum: number } }> {
    return this.post("/api/v1/pay/events", { customer, feature, ...options });
  }

  // ── Customers ────────────────────────────────────────────────────────────

  /**
   * Idempotent get-or-create customer. Returns full state with subscriptions, balances, payment methods.
   * Call on every login/signup — safe to call repeatedly.
   */
  async getOrCreateCustomer(input: {
    customerId: string;
    name?: string;
    email?: string;
  }): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/customers", input);
  }

  /** Get a customer by external ID. Returns subscriptions, balances, payment methods. */
  async getCustomer(externalId: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/pay/customers?id=${encodeURIComponent(externalId)}`);
  }

  /** List all customers. */
  async listCustomers(): Promise<Record<string, unknown>[]> {
    return this.get("/api/v1/pay/customers");
  }

  /** Update customer properties (name, email). */
  async updateCustomer(input: {
    customerId: string;
    name?: string;
    email?: string;
  }): Promise<Record<string, unknown>> {
    return this.request("PUT", "/api/v1/pay/customers", input);
  }

  /** Delete a customer mapping by external ID. */
  async deleteCustomer(customerId: string): Promise<void> {
    await this.request("DELETE", `/api/v1/pay/customers?id=${encodeURIComponent(customerId)}`);
  }

  // ── Balances ──────────────────────────────────────────────────────────────

  /** Create a standalone balance (promotional credits, rewards). */
  async createBalance(input: {
    customer: string;
    feature: string;
    grantedBalance: number;
    resetInterval?: "month" | "year" | "one_off";
  }): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/balances/create", input);
  }

  /** Set usage directly or update balance for a feature. */
  async updateBalance(input: {
    customer: string;
    feature: string;
    usage?: number;
    balance?: number;
  }): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/balances/update", input);
  }

  // ── Entities ────────────────────────────────────────────────────────────

  /** Create an entity (user, workspace, seat) under a customer. Auto-increments seat count. */
  async createEntity(input: {
    customer: string;
    entityId: string;
    featureId: string;
    name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/entities", input);
  }

  /** List entities for a customer. */
  async listEntities(customer: string): Promise<Record<string, unknown>[]> {
    return this.get(`/api/v1/pay/entities?customer=${encodeURIComponent(customer)}`);
  }

  /** Delete an entity. Auto-decrements seat count. */
  async deleteEntity(customer: string, entityId: string): Promise<Record<string, unknown>> {
    return this.request("DELETE", "/api/v1/pay/entities", { customer, entityId });
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  /** List subscriptions, optionally filtered by status. */
  async listSubscriptions(status?: string): Promise<Record<string, unknown>[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.get(`/api/v1/pay/subscriptions${query}`);
  }

  // ── Portal ──────────────────────────────────────────────────────────────

  /** Generate a customer billing portal URL (1-hour TTL). */
  async portal(customer: string): Promise<{ url: string }> {
    return this.get(`/api/v1/pay/portal?customer=${encodeURIComponent(customer)}`);
  }

  // ── Analytics ──────────────────────────────────────────────────────────

  /** Get billing analytics (MRR, ARR, churn, ARPU, trial conversion). */
  async analytics(): Promise<Record<string, unknown>> {
    return this.get("/api/v1/pay/analytics");
  }

  /** Get monthly revenue timeline. */
  async revenueTimeline(months?: number): Promise<Record<string, unknown>[]> {
    const query = months ? `?view=timeline&months=${months}` : "?view=timeline";
    return this.get(`/api/v1/pay/analytics${query}`);
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────

  /** Register a webhook endpoint. Returns the signing secret once. */
  async createWebhook(input: CreateWebhookInput): Promise<WebhookEndpoint> {
    return this.post("/api/v1/pay/webhooks", input);
  }

  /** List webhook endpoints (secrets are redacted). */
  async listWebhooks(): Promise<WebhookEndpoint[]> {
    return this.get("/api/v1/pay/webhooks");
  }

  /** Delete a webhook endpoint. */
  async deleteWebhook(id: string): Promise<void> {
    await this.request("DELETE", `/api/v1/pay/webhooks?id=${encodeURIComponent(id)}`);
  }

  // ── Coupons ──────────────────────────────────────────────────────────────

  /** List all coupons. Supports pagination via query params. */
  async listCoupons(): Promise<Record<string, unknown>[]> {
    return this.get("/api/v1/pay/coupons");
  }

  /** Create a coupon. */
  async createCoupon(input: CreateCouponInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/coupons", input);
  }

  /** Get a coupon by ID. */
  async getCoupon(id: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/pay/coupons/${encodeURIComponent(id)}`);
  }

  /** Update a coupon by ID. */
  async updateCoupon(id: string, input: UpdateCouponInput): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/v1/pay/coupons/${encodeURIComponent(id)}`, input);
  }

  /** Archive a coupon by ID (shorthand for updateCoupon with status: "archived"). */
  async archiveCoupon(id: string): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/v1/pay/coupons/${encodeURIComponent(id)}`, { status: "archived" });
  }

  /**
   * Validate a coupon code without redeeming it.
   * Safe to call from client-side (supports publishable keys).
   */
  async validateCoupon(input: ValidateCouponInput): Promise<{ valid: boolean; discount?: Record<string, unknown> }> {
    return this.post("/api/v1/pay/coupons/validate", input);
  }

  // ── Spend Caps ──────────────────────────────────────────────────────────

  /** Get spend cap status for a customer's feature. */
  async getSpendCap(customer: string, feature: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/pay/spend-caps?customer=${encodeURIComponent(customer)}&feature=${encodeURIComponent(feature)}`);
  }

  /** Set a spend cap on a customer's feature. Pass capCents: null to remove. */
  async setSpendCap(input: SetSpendCapInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/spend-caps", input);
  }

  /** Set a product-level default spend cap for a feature. */
  async setProductSpendCap(input: Omit<SetProductSpendCapInput, "scope">): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/spend-caps", { ...input, scope: "product" });
  }

  // ── Rewards ─────────────────────────────────────────────────────────────

  /** List reward programs. */
  async listRewardPrograms(): Promise<Record<string, unknown>[]> {
    return this.get("/api/v1/pay/rewards");
  }

  /** List referral codes for a customer. */
  async listReferralCodes(customer: string): Promise<Record<string, unknown>[]> {
    return this.get(`/api/v1/pay/rewards?customer=${encodeURIComponent(customer)}`);
  }

  /** Create a reward program. */
  async createRewardProgram(input: CreateRewardProgramInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/rewards", input);
  }

  /** Create a referral code for a customer under a reward program. */
  async createReferralCode(input: CreateReferralCodeInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/rewards?action=code", input);
  }

  /** Redeem a referral code. Atomically validates limits and applies the reward. */
  async redeemReferralCode(input: RedeemReferralInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/pay/rewards?action=redeem", input);
  }

  // ── HTTP Layer ───────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      Accept: "application/json",
    };

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
      throw new CyncoPayError(message, code, response.status, errorBody?.error?.details);
    }

    const json = await response.json() as ApiResponse<T>;
    if (!json.success) {
      throw new CyncoPayError(
        json.error?.message ?? "Unknown error",
        json.error?.code ?? "UNKNOWN",
        response.status,
        json.error?.details,
      );
    }

    if (json.data === undefined) {
      throw new CyncoPayError("Empty response from server", "EMPTY_RESPONSE", response.status);
    }
    return json.data as T;
  }
}

/**
 * Error thrown by the Cynco Pay SDK.
 * Contains the error code and optional field-level validation details.
 */
export class CyncoPayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = "CyncoPayError";
  }
}
