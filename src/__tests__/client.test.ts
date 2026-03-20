import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CyncoBilling, CyncoBillingError } from "../client.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function ok(data: unknown, status = 200) {
  return { ok: true, status, json: async () => ({ success: true, data }) };
}

function err(code: string, message: string, status: number, details?: { field: string; message: string }[]) {
  return {
    ok: false,
    status,
    json: async () => ({ success: false, error: { code, message, details } }),
  };
}

function pay(key = "cp_sk_test") {
  return new CyncoBilling({ key, baseUrl: "https://test.cynco.io" });
}

function lastCall() {
  const [url, opts] = mockFetch.mock.calls.at(-1)!;
  return {
    url: url as string,
    method: opts.method as string,
    headers: opts.headers as Record<string, string>,
    body: opts.body ? JSON.parse(opts.body as string) : undefined,
  };
}

// ── Constructor ──────────────────────────────────────────────────────────────

describe("CyncoBilling constructor", () => {
  it("throws if key is missing", () => {
    expect(() => new CyncoBilling({ key: "" })).toThrow("key is required");
  });

  it("uses default base URL", () => {
    const p = new CyncoBilling({ key: "cp_sk_test" });
    expect(p).toBeDefined();
  });

  it("strips trailing slash from base URL", async () => {
    const p = new CyncoBilling({ key: "cp_sk_test", baseUrl: "https://test.cynco.io/" });
    mockFetch.mockResolvedValue(ok([]));
    await p.listProducts();
    expect(lastCall().url).toBe("https://test.cynco.io/api/v1/pay/products");
  });
});

// ── Subscribe ────────────────────────────────────────────────────────────────

describe("subscribe", () => {
  it("sends correct request and returns result", async () => {
    mockFetch.mockResolvedValue(
      ok({ action: "checkout", url: "https://chip.example/checkout" }),
    );

    const result = await pay().subscribe({
      customer: { id: "user_1", email: "jane@example.com", name: "Jane" },
      product: "pro",
      successUrl: "https://myapp.com/success",
      cancelUrl: "https://myapp.com/cancel",
    });

    expect(result.action).toBe("checkout");
    expect(result.url).toBe("https://chip.example/checkout");

    const req = lastCall();
    expect(req.url).toBe("https://test.cynco.io/api/v1/pay/subscribe");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer cp_sk_test");
    expect(req.body.customer).toEqual({ id: "user_1", email: "jane@example.com", name: "Jane" });
    expect(req.body.product).toBe("pro");
  });

  it("sends idempotency key when provided", async () => {
    mockFetch.mockResolvedValue(
      ok({ action: "activated", subscription: { id: "psub_1" } }),
    );

    await pay().subscribe(
      { customer: "user_1", product: "pro" },
      { idempotencyKey: "req_abc" },
    );

    expect(lastCall().headers["Idempotency-Key"]).toBe("req_abc");
  });

  it("sends coupon code and billing anchor", async () => {
    mockFetch.mockResolvedValue(ok({ action: "checkout", url: "https://chip.example/pay" }));

    await pay().subscribe({
      customer: "user_1",
      product: "pro",
      couponCode: "SAVE20",
      billingAnchorDay: 15,
      fingerprint: "fp_abc",
    });

    expect(lastCall().body).toMatchObject({
      couponCode: "SAVE20",
      billingAnchorDay: 15,
      fingerprint: "fp_abc",
    });
  });
});

// ── Check ────────────────────────────────────────────────────────────────────

describe("check", () => {
  it("sends correct request", async () => {
    mockFetch.mockResolvedValue(
      ok({ allowed: true, balance: 950, limit: 1000, unlimited: false, overageAllowed: false }),
    );

    const result = await pay().check("user_1", "api_calls");

    expect(result.allowed).toBe(true);
    expect(result.balance).toBe(950);
    expect(lastCall().body).toEqual({ customer: "user_1", feature: "api_calls" });
  });

  it("supports sendEvent for atomic check+deduct", async () => {
    mockFetch.mockResolvedValue(
      ok({ allowed: true, balance: 949, limit: 1000, unlimited: false, overageAllowed: false }),
    );

    await pay().check("user_1", "api_calls", { sendEvent: true });

    expect(lastCall().body).toEqual({ customer: "user_1", feature: "api_calls", sendEvent: true });
  });

  it("supports balance lock", async () => {
    mockFetch.mockResolvedValue(
      ok({ allowed: true, balance: 6000, limit: 10000, unlimited: false, overageAllowed: false, lockId: "lock_123" }),
    );

    const result = await pay().check("user_1", "ai_tokens", {
      requiredBalance: 4000,
      lock: { enabled: true, expiresAt: Date.now() + 60_000 },
    });

    expect(result.lockId).toBe("lock_123");
    expect(lastCall().body.lock.enabled).toBe(true);
  });

  it("supports entity-scoped check", async () => {
    mockFetch.mockResolvedValue(
      ok({ allowed: true, balance: null, limit: null, unlimited: false, overageAllowed: false }),
    );

    await pay().check("org_1", "workspace_access", { entityId: "ws_abc" });

    expect(lastCall().body).toMatchObject({ entityId: "ws_abc" });
  });
});

// ── Track ────────────────────────────────────────────────────────────────────

describe("track", () => {
  it("sends correct request with options", async () => {
    mockFetch.mockResolvedValue(
      ok({ recorded: true, allowed: true, balance: 99, limit: 100, unlimited: false, duplicate: false }),
    );

    const result = await pay().track("user_1", "api_calls", {
      amount: 1,
      idempotencyKey: "req_abc",
    });

    expect(result.recorded).toBe(true);
    expect(result.balance).toBe(99);
    expect(lastCall().body).toEqual({
      customer: "user_1",
      feature: "api_calls",
      amount: 1,
      idempotencyKey: "req_abc",
    });
  });

  it("defaults when options are omitted", async () => {
    mockFetch.mockResolvedValue(
      ok({ recorded: true, allowed: true, balance: 99, limit: 100, unlimited: false, duplicate: false }),
    );

    await pay().track("user_1", "api_calls");
    expect(lastCall().body).toEqual({ customer: "user_1", feature: "api_calls" });
  });

  it("reports spend cap exceeded", async () => {
    mockFetch.mockResolvedValue(
      ok({ recorded: false, allowed: false, balance: 0, limit: 100, unlimited: false, duplicate: false, spendCapExceeded: true }),
    );

    const result = await pay().track("user_1", "api_calls");
    expect(result.spendCapExceeded).toBe(true);
    expect(result.recorded).toBe(false);
  });

  it("reports duplicate", async () => {
    mockFetch.mockResolvedValue(
      ok({ recorded: false, allowed: true, balance: 99, limit: 100, unlimited: false, duplicate: true }),
    );

    const result = await pay().track("user_1", "api_calls", { idempotencyKey: "already_sent" });
    expect(result.duplicate).toBe(true);
    expect(result.recorded).toBe(false);
  });
});

// ── Cancel ───────────────────────────────────────────────────────────────────

describe("cancel", () => {
  it("sends correct request", async () => {
    mockFetch.mockResolvedValue(
      ok({ canceled: true, effectiveAt: "2026-04-01T00:00:00Z" }),
    );

    const result = await pay().cancel("user_1", { product: "pro", immediate: false });

    expect(result.canceled).toBe(true);
    expect(result.effectiveAt).toBe("2026-04-01T00:00:00Z");
    expect(lastCall().body).toEqual({ customer: "user_1", product: "pro", immediate: false });
  });

  it("cancels all subscriptions when product is omitted", async () => {
    mockFetch.mockResolvedValue(ok({ canceled: true, effectiveAt: null }));

    await pay().cancel("user_1");
    expect(lastCall().body).toEqual({ customer: "user_1" });
  });

  it("supports idempotency key", async () => {
    mockFetch.mockResolvedValue(ok({ canceled: true, effectiveAt: null }));

    await pay().cancel("user_1", { product: "pro" }, { idempotencyKey: "cancel_abc" });
    expect(lastCall().headers["Idempotency-Key"]).toBe("cancel_abc");
  });
});

// ── Finalize Lock ────────────────────────────────────────────────────────────

describe("finalizeLock", () => {
  it("confirms a lock with override", async () => {
    mockFetch.mockResolvedValue(ok({ success: true, adjusted: 150 }));

    const result = await pay().finalizeLock({
      lockId: "lock_123",
      action: "confirm",
      overrideValue: 150,
    });

    expect(result.adjusted).toBe(150);
    expect(lastCall().body).toEqual({ lockId: "lock_123", action: "confirm", overrideValue: 150 });
  });

  it("releases a lock", async () => {
    mockFetch.mockResolvedValue(ok({ success: true, adjusted: 0 }));

    const result = await pay().finalizeLock({ lockId: "lock_123", action: "release" });

    expect(result.adjusted).toBe(0);
  });
});

// ── Products ─────────────────────────────────────────────────────────────────

describe("products", () => {
  it("lists products", async () => {
    mockFetch.mockResolvedValue(ok([{ id: "pprod_1", name: "Pro", slug: "pro" }]));

    const products = await pay().listProducts();
    expect(products).toHaveLength(1);
    expect(lastCall().method).toBe("GET");
    expect(lastCall().url).toBe("https://test.cynco.io/api/v1/pay/products");
  });

  it("lists products with pagination", async () => {
    mockFetch.mockResolvedValue(ok([{ id: "pprod_1" }]));

    await pay().listProducts({ limit: 5, offset: 10 });
    expect(lastCall().url).toContain("limit=5");
    expect(lastCall().url).toContain("offset=10");
  });

  it("creates a product", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pprod_new", name: "Enterprise", slug: "enterprise" }));

    const product = await pay().createProduct({
      name: "Enterprise",
      slug: "enterprise",
      prices: [{ type: "recurring", amount: 9900, billingInterval: "month" }],
      features: [
        { slug: "api_calls", name: "API Calls", type: "metered", allowanceType: "fixed", allowance: 50000 },
        { slug: "sso", name: "SSO", type: "boolean" },
      ],
    });

    expect(product.slug).toBe("enterprise");
    expect(lastCall().body.prices).toHaveLength(1);
    expect(lastCall().body.features).toHaveLength(2);
  });
});

// ── Plans ────────────────────────────────────────────────────────────────────

describe("plans", () => {
  it("lists plans without customer", async () => {
    mockFetch.mockResolvedValue(ok([{ id: "pprod_1", slug: "pro" }]));

    await pay().listPlans();
    expect(lastCall().url).toBe("https://test.cynco.io/api/v1/pay/plans");
  });

  it("lists plans with customer for eligibility", async () => {
    mockFetch.mockResolvedValue(ok([{
      id: "pprod_1",
      slug: "pro",
      customerEligibility: { scenario: "upgrade", prorationAmount: 500 },
    }]));

    const plans = await pay().listPlans("user_1");
    expect(lastCall().url).toContain("customer=user_1");
    expect(plans[0].customerEligibility?.scenario).toBe("upgrade");
  });

  it("previews subscription attach", async () => {
    mockFetch.mockResolvedValue(ok({
      scenario: "upgrade",
      amountDue: 3500,
      lineItems: [
        { title: "Enterprise", description: "Monthly", amount: 5000 },
        { title: "Credit for Pro", description: "Prorated", amount: -1500 },
      ],
    }));

    const preview = await pay().previewAttach("user_1", "enterprise");
    expect(preview.amountDue).toBe(3500);
    expect(preview.lineItems).toHaveLength(2);
  });
});

// ── Pricing Table ────────────────────────────────────────────────────────────

describe("getPricingTable", () => {
  it("fetches pricing table without customer", async () => {
    mockFetch.mockResolvedValue(ok({
      plans: [{ id: "pprod_1", name: "Pro", prices: [{ amountFormatted: "MYR 9.90" }] }],
      groups: [{ slug: "main", planCount: 3 }],
    }));

    const result = await pay().getPricingTable();
    expect(result.plans[0].prices[0].amountFormatted).toBe("MYR 9.90");
    expect(result.groups).toHaveLength(1);
    expect(lastCall().url).toBe("https://test.cynco.io/api/v1/pay/components/pricing-table");
  });

  it("fetches pricing table with customer", async () => {
    mockFetch.mockResolvedValue(ok({ plans: [], groups: [] }));

    await pay().getPricingTable("user_1");
    expect(lastCall().url).toContain("customer=user_1");
  });
});

// ── Customers ────────────────────────────────────────────────────────────────

describe("customers", () => {
  it("get-or-creates a customer", async () => {
    mockFetch.mockResolvedValue(ok({
      id: "pcm_1",
      externalId: "user_1",
      environment: "test",
      name: "Jane",
      email: "jane@example.com",
      subscriptions: [],
      balances: {},
      flags: {},
      paymentMethods: [],
    }));

    const customer = await pay().getOrCreateCustomer({
      customerId: "user_1",
      name: "Jane",
      email: "jane@example.com",
    });

    expect(customer.externalId).toBe("user_1");
    expect(customer.environment).toBe("test");
  });

  it("gets a customer by ID", async () => {
    mockFetch.mockResolvedValue(ok({
      id: "pcm_1",
      externalId: "user_1",
      subscriptions: [{ id: "psub_1", status: "active", productSlug: "pro" }],
      balances: { api_calls: { balance: 9500, limit: 10000, unlimited: false } },
      flags: { sso: true },
    }));

    const customer = await pay().getCustomer("user_1");
    expect(customer.subscriptions).toHaveLength(1);
    expect(customer.balances.api_calls.balance).toBe(9500);
    expect(customer.flags.sso).toBe(true);
  });

  it("updates a customer", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pcm_1", externalId: "user_1", name: "Jane Smith" }));

    const customer = await pay().updateCustomer({ customerId: "user_1", name: "Jane Smith" });
    expect(lastCall().method).toBe("PUT");
    expect(customer.name).toBe("Jane Smith");
  });

  it("deletes a customer", async () => {
    mockFetch.mockResolvedValue(ok({ deleted: true }));

    const result = await pay().deleteCustomer("user_1");
    expect(result.deleted).toBe(true);
    expect(lastCall().method).toBe("DELETE");
    expect(lastCall().url).toContain("id=user_1");
  });
});

// ── Subscriptions ────────────────────────────────────────────────────────────

describe("subscriptions", () => {
  it("lists subscriptions", async () => {
    mockFetch.mockResolvedValue(ok([{ id: "psub_1", status: "active" }]));

    const subs = await pay().listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(lastCall().url).toBe("https://test.cynco.io/api/v1/pay/subscriptions");
  });

  it("lists subscriptions filtered by status", async () => {
    mockFetch.mockResolvedValue(ok([]));

    await pay().listSubscriptions("active,trialing");
    expect(lastCall().url).toContain("status=active%2Ctrialing");
  });

  it("updates a subscription", async () => {
    mockFetch.mockResolvedValue(ok({
      updated: true,
      action: "canceled",
      subscription: { id: "psub_1", status: "active", productSlug: "pro", quantity: 1 },
    }));

    const result = await pay().updateSubscription({
      customer: "user_1",
      product: "pro",
      cancelAction: "cancel_end_of_cycle",
    });

    expect(result.updated).toBe(true);
    expect(result.action).toBe("canceled");
  });

  it("pauses a subscription", async () => {
    mockFetch.mockResolvedValue(ok({ updated: true, action: "paused" }));

    await pay().updateSubscription({
      customer: "user_1",
      product: "pro",
      pauseAction: "pause",
      resumeAt: "2026-04-01T00:00:00Z",
    });

    expect(lastCall().body).toMatchObject({
      pauseAction: "pause",
      resumeAt: "2026-04-01T00:00:00Z",
    });
  });

  it("previews a subscription update", async () => {
    mockFetch.mockResolvedValue(ok({
      updated: false,
      action: "preview",
      lineItems: [{ title: "Pro", description: "5 seats", amount: 5000 }],
      total: 5000,
    }));

    const preview = await pay().previewUpdate({
      customer: "user_1",
      product: "pro",
      quantity: 5,
    });

    expect(preview.total).toBe(5000);
    expect(lastCall().url).toContain("preview-update");
  });
});

// ── Balances ─────────────────────────────────────────────────────────────────

describe("balances", () => {
  it("creates a balance", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pbal_1", balance: 500 }));

    await pay().createBalance({
      customer: "user_1",
      feature: "credits",
      grantedBalance: 500,
      resetInterval: "month",
    });

    expect(lastCall().body).toEqual({
      customer: "user_1",
      feature: "credits",
      grantedBalance: 500,
      resetInterval: "month",
    });
  });

  it("updates a balance", async () => {
    mockFetch.mockResolvedValue(ok({ balance: 100 }));

    await pay().updateBalance({ customer: "user_1", feature: "credits", balance: 100 });
    expect(lastCall().body).toEqual({ customer: "user_1", feature: "credits", balance: 100 });
  });
});

// ── Entities ─────────────────────────────────────────────────────────────────

describe("entities", () => {
  it("creates an entity", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pent_1", entityId: "user_alice", featureId: "seats" }));

    const entity = await pay().createEntity({
      customer: "org_1",
      entityId: "user_alice",
      featureId: "seats",
      name: "Alice",
    });

    expect(entity.entityId).toBe("user_alice");
  });

  it("lists entities", async () => {
    mockFetch.mockResolvedValue(ok([{ id: "pent_1" }, { id: "pent_2" }]));

    const entities = await pay().listEntities("org_1");
    expect(entities).toHaveLength(2);
    expect(lastCall().url).toContain("customer=org_1");
  });

  it("deletes an entity", async () => {
    mockFetch.mockResolvedValue(ok({ deleted: true }));

    await pay().deleteEntity("org_1", "user_alice");
    expect(lastCall().method).toBe("DELETE");
    expect(lastCall().body).toEqual({ customer: "org_1", entityId: "user_alice" });
  });
});

// ── Portal ───────────────────────────────────────────────────────────────────

describe("portal", () => {
  it("generates a portal URL", async () => {
    mockFetch.mockResolvedValue(ok({ url: "https://app.cynco.io/portal/billing?token=abc" }));

    const result = await pay().portal("user_1");
    expect(result.url).toContain("portal/billing");
    expect(lastCall().url).toContain("customer=user_1");
  });
});

// ── Analytics ────────────────────────────────────────────────────────────────

describe("analytics", () => {
  it("gets analytics summary", async () => {
    mockFetch.mockResolvedValue(ok({
      mrr: 15000,
      arr: 180000,
      activeSubscriptions: 42,
      arpu: 357,
      churnRate: 2.5,
      trialConversionRate: 68,
    }));

    const summary = await pay().analytics();
    expect(summary.mrr).toBe(15000);
    expect(summary.arr).toBe(180000);
  });

  it("gets revenue timeline", async () => {
    mockFetch.mockResolvedValue(ok([
      { month: "2026-01", revenue: 12000, newSubscriptions: 5, churned: 1 },
      { month: "2026-02", revenue: 14000, newSubscriptions: 8, churned: 2 },
    ]));

    const timeline = await pay().revenueTimeline(6);
    expect(timeline).toHaveLength(2);
    expect(lastCall().url).toContain("view=timeline");
    expect(lastCall().url).toContain("months=6");
  });
});

// ── Usage Events ─────────────────────────────────────────────────────────────

describe("aggregateEvents", () => {
  it("aggregates usage events", async () => {
    mockFetch.mockResolvedValue(ok({
      timeline: [
        { period: "2026-03-01", count: 150, total: 150 },
        { period: "2026-03-02", count: 200, total: 200 },
      ],
      total: { count: 350, sum: 350 },
    }));

    const result = await pay().aggregateEvents("user_1", "api_calls", {
      range: "7d",
      groupBy: "day",
    });

    expect(result.timeline).toHaveLength(2);
    expect(result.total.count).toBe(350);
  });
});

// ── Webhooks ─────────────────────────────────────────────────────────────────

describe("webhooks", () => {
  it("creates a webhook endpoint", async () => {
    mockFetch.mockResolvedValue(ok({
      id: "pwh_1",
      url: "https://myapp.com/webhooks",
      secret: "whsec_abc123",
      events: ["subscription.activated"],
      status: "active",
    }));

    const webhook = await pay().createWebhook({
      url: "https://myapp.com/webhooks",
      events: ["subscription.activated"],
    });

    expect(webhook.secret).toBe("whsec_abc123");
  });

  it("lists webhook endpoints", async () => {
    mockFetch.mockResolvedValue(ok([{ id: "pwh_1", url: "https://myapp.com/webhooks" }]));

    const webhooks = await pay().listWebhooks();
    expect(webhooks).toHaveLength(1);
  });

  it("deletes a webhook endpoint", async () => {
    mockFetch.mockResolvedValue(ok({ deleted: true }));

    const result = await pay().deleteWebhook("pwh_1");
    expect(result.deleted).toBe(true);
    expect(lastCall().url).toContain("id=pwh_1");
  });
});

// ── Coupons ──────────────────────────────────────────────────────────────────

describe("coupons", () => {
  it("creates a coupon with correct field names", async () => {
    mockFetch.mockResolvedValue(ok({
      id: "pcpn_1",
      code: "SAVE20",
      type: "percentage",
      value: 20,
      duration: "repeating",
      durationMonths: 3,
      status: "active",
    }));

    const coupon = await pay().createCoupon({
      code: "SAVE20",
      type: "percentage",
      value: 20,
      duration: "repeating",
      durationMonths: 3,
      maxRedemptions: 100,
    });

    expect(coupon.type).toBe("percentage");
    expect(coupon.value).toBe(20);

    // Verify the SDK sends the correct field names to the server
    expect(lastCall().body.type).toBe("percentage");
    expect(lastCall().body.value).toBe(20);
    expect(lastCall().body.durationMonths).toBe(3);
    // Ensure old wrong field names are NOT sent
    expect(lastCall().body.discountType).toBeUndefined();
    expect(lastCall().body.discountValue).toBeUndefined();
    expect(lastCall().body.durationInMonths).toBeUndefined();
  });

  it("creates a trial extension coupon", async () => {
    mockFetch.mockResolvedValue(ok({
      id: "pcpn_2",
      code: "EXTRA7",
      type: "trial_extension",
      value: 7,
      duration: "once",
    }));

    await pay().createCoupon({
      code: "EXTRA7",
      type: "trial_extension",
      value: 7,
      duration: "once",
    });

    expect(lastCall().body.type).toBe("trial_extension");
  });

  it("lists coupons", async () => {
    mockFetch.mockResolvedValue(ok([{ id: "pcpn_1", code: "SAVE20" }]));

    const coupons = await pay().listCoupons();
    expect(coupons).toHaveLength(1);
  });

  it("gets a coupon by ID", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pcpn_1", code: "SAVE20" }));

    const coupon = await pay().getCoupon("pcpn_1");
    expect(coupon.code).toBe("SAVE20");
  });

  it("updates a coupon", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pcpn_1", name: "Summer Sale", status: "active" }));

    const coupon = await pay().updateCoupon("pcpn_1", { name: "Summer Sale" });
    expect(coupon.name).toBe("Summer Sale");
    expect(lastCall().method).toBe("PATCH");
  });

  it("archives a coupon", async () => {
    mockFetch.mockResolvedValue(ok({ archived: true }));

    const result = await pay().archiveCoupon("pcpn_1");
    expect(result.archived).toBe(true);
    expect(lastCall().method).toBe("DELETE");
  });

  it("validates a coupon", async () => {
    mockFetch.mockResolvedValue(ok({
      valid: true,
      discountAmount: 200,
      finalAmount: 800,
      couponType: "percentage",
      duration: "once",
    }));

    const result = await pay().validateCoupon({
      code: "SAVE20",
      customer: "user_1",
      product: "pro",
      amount: 1000,
    });

    expect(result.valid).toBe(true);
    expect(result.discountAmount).toBe(200);
    expect(result.finalAmount).toBe(800);
  });

  it("validates an invalid coupon", async () => {
    mockFetch.mockResolvedValue(ok({
      valid: false,
      message: "Coupon has expired",
    }));

    const result = await pay().validateCoupon({
      code: "EXPIRED",
      customer: "user_1",
      product: "pro",
      amount: 1000,
    });

    expect(result.valid).toBe(false);
    expect(result.message).toBe("Coupon has expired");
  });
});

// ── Spend Caps ───────────────────────────────────────────────────────────────

describe("spend caps", () => {
  it("gets spend cap status", async () => {
    mockFetch.mockResolvedValue(ok({
      customerId: "pcm_1",
      featureId: "api_calls",
      capCents: 5000,
      accruedCents: 1200,
      remainingCents: 3800,
      unlimited: false,
    }));

    const status = await pay().getSpendCap("user_1", "api_calls");
    expect(status.capCents).toBe(5000);
    expect(status.remainingCents).toBe(3800);
  });

  it("sets a spend cap", async () => {
    mockFetch.mockResolvedValue(ok({ capCents: 10000, accruedCents: 0, remainingCents: 10000 }));

    await pay().setSpendCap({ customer: "user_1", feature: "api_calls", capCents: 10000 });
    expect(lastCall().body.capCents).toBe(10000);
  });

  it("removes a spend cap", async () => {
    mockFetch.mockResolvedValue(ok({ capCents: null, unlimited: true }));

    await pay().setSpendCap({ customer: "user_1", feature: "api_calls", capCents: null });
    expect(lastCall().body.capCents).toBeNull();
  });

  it("sets a product default spend cap", async () => {
    mockFetch.mockResolvedValue(ok({ scope: "product", capCents: 5000 }));

    await pay().setProductSpendCap({ productId: "pprod_1", featureId: "api_calls", capCents: 5000 });
    expect(lastCall().body).toMatchObject({ scope: "product", productId: "pprod_1" });
  });
});

// ── API Keys ─────────────────────────────────────────────────────────────────

describe("api keys", () => {
  it("creates an API key", async () => {
    mockFetch.mockResolvedValue(ok({
      id: "pak_1",
      name: "Production",
      type: "secret",
      keyPrefix: "cp_sk_",
      environment: "live",
      rawKey: "cp_sk_live_abc123xyz",
      status: "active",
    }));

    const key = await pay().createApiKey({ name: "Production", type: "secret" });
    expect(key.rawKey).toBe("cp_sk_live_abc123xyz");
    expect(key.type).toBe("secret");
  });

  it("lists API keys (no raw key)", async () => {
    mockFetch.mockResolvedValue(ok([{
      id: "pak_1",
      name: "Production",
      type: "secret",
      keyPrefix: "cp_sk_",
      environment: "live",
      status: "active",
    }]));

    const keys = await pay().listApiKeys();
    expect(keys).toHaveLength(1);
    expect((keys[0] as Record<string, unknown>).rawKey).toBeUndefined();
  });

  it("revokes an API key", async () => {
    mockFetch.mockResolvedValue(ok({ revoked: true }));

    const result = await pay().revokeApiKey("pak_1");
    expect(result.revoked).toBe(true);
    expect(lastCall().url).toContain("id=pak_1");
  });
});

// ── Audit Log ────────────────────────────────────────────────────────────────

describe("audit log", () => {
  it("lists audit events", async () => {
    mockFetch.mockResolvedValue(ok([{
      id: "paudit_1",
      event: "subscription.activated",
      actorType: "api",
      details: {},
    }]));

    const events = await pay().listAuditEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("subscription.activated");
  });

  it("filters audit events", async () => {
    mockFetch.mockResolvedValue(ok([]));

    await pay().listAuditEvents({
      subscriptionId: "psub_1",
      event: "payment.succeeded",
      limit: 10,
    });

    const url = lastCall().url;
    expect(url).toContain("subscription=psub_1");
    expect(url).toContain("event=payment.succeeded");
    expect(url).toContain("limit=10");
  });
});

// ── Rewards ──────────────────────────────────────────────────────────────────

describe("rewards", () => {
  it("creates a reward program", async () => {
    mockFetch.mockResolvedValue(ok({
      id: "prw_1",
      name: "Referral Program",
      rewardType: "credit",
      rewardValue: 500,
    }));

    const program = await pay().createRewardProgram({
      name: "Referral Program",
      rewardType: "credit",
      rewardValue: 500,
      trigger: "referral_subscribe",
    });

    expect(program.rewardType).toBe("credit");
  });

  it("lists reward programs", async () => {
    mockFetch.mockResolvedValue(ok([{ id: "prw_1" }]));

    const programs = await pay().listRewardPrograms();
    expect(programs).toHaveLength(1);
  });

  it("creates a referral code", async () => {
    mockFetch.mockResolvedValue(ok({ id: "prc_1", code: "JANE20", customerId: "user_1" }));

    const code = await pay().createReferralCode({
      programId: "prw_1",
      customer: "user_1",
      code: "JANE20",
    });

    expect(code.code).toBe("JANE20");
    expect(lastCall().url).toContain("action=code");
  });

  it("lists referral codes for a customer", async () => {
    mockFetch.mockResolvedValue(ok([{ id: "prc_1", code: "JANE20" }]));

    const codes = await pay().listReferralCodes("user_1");
    expect(codes).toHaveLength(1);
    expect(lastCall().url).toContain("customer=user_1");
  });

  it("redeems a referral code", async () => {
    mockFetch.mockResolvedValue(ok({ redeemed: true }));

    await pay().redeemReferralCode({
      programId: "prw_1",
      code: "JANE20",
      customer: "user_2",
    });

    expect(lastCall().url).toContain("action=redeem");
    expect(lastCall().body.customer).toBe("user_2");
  });
});

// ── Error Handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
  it("throws CyncoBillingError on 4xx with details", async () => {
    mockFetch.mockResolvedValue(
      err("VALIDATION_ERROR", "Invalid input", 422, [{ field: "product", message: "Required" }]),
    );

    try {
      await pay().subscribe({ customer: "user_1", product: "" });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CyncoBillingError);
      const error = e as CyncoBillingError;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.status).toBe(422);
      expect(error.details).toHaveLength(1);
      expect(error.details![0].field).toBe("product");
    }
  });

  it("throws CyncoBillingError on 401", async () => {
    mockFetch.mockResolvedValue(
      err("UNAUTHORIZED", "Invalid API key", 401),
    );

    try {
      await pay("cp_sk_invalid").check("user_1", "feature");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CyncoBillingError);
      expect((e as CyncoBillingError).code).toBe("UNAUTHORIZED");
    }
  });

  it("throws CyncoBillingError on 403 for publishable key on secret-only endpoint", async () => {
    mockFetch.mockResolvedValue(
      err("FORBIDDEN", "Secret key required", 403),
    );

    try {
      await pay("cp_pk_test").cancel("user_1");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CyncoBillingError);
      expect((e as CyncoBillingError).code).toBe("FORBIDDEN");
      expect((e as CyncoBillingError).status).toBe(403);
    }
  });

  it("throws CyncoBillingError on 429 concurrent request", async () => {
    mockFetch.mockResolvedValue(
      err("CONCURRENT_REQUEST", "Another operation is in progress for this customer", 429),
    );

    try {
      await pay().subscribe({ customer: "user_1", product: "pro" });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CyncoBillingError);
      expect((e as CyncoBillingError).code).toBe("CONCURRENT_REQUEST");
    }
  });

  it("handles non-JSON error responses", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json"); },
    });

    try {
      await pay().check("user_1", "feature");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CyncoBillingError);
      expect((e as CyncoBillingError).message).toBe("HTTP 500");
      expect((e as CyncoBillingError).code).toBe("REQUEST_FAILED");
    }
  });

  it("handles success:false in response body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        error: { code: "SUBSCRIBE_FAILED", message: "Product not found" },
      }),
    });

    try {
      await pay().subscribe({ customer: "user_1", product: "nonexistent" });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CyncoBillingError);
      expect((e as CyncoBillingError).code).toBe("SUBSCRIBE_FAILED");
    }
  });
});

// ── API Version Header ───────────────────────────────────────────────────────

describe("api version", () => {
  it("sends API version header when configured", async () => {
    const p = new CyncoBilling({
      key: "cp_sk_test",
      baseUrl: "https://test.cynco.io",
      apiVersion: "2026-03-19",
    });

    mockFetch.mockResolvedValue(ok({ allowed: true }));
    await p.check("user_1", "feature");

    expect(lastCall().headers["X-CyncoBilling-Version"]).toBe("2026-03-19");
  });

  it("does not send API version header when not configured", async () => {
    mockFetch.mockResolvedValue(ok({ allowed: true }));
    await pay().check("user_1", "feature");

    expect(lastCall().headers["X-CyncoBilling-Version"]).toBeUndefined();
  });
});
