import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CyncoPay, CyncoPayError } from "../client.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function pay() {
  return new CyncoPay({ key: "cp_sk_test", baseUrl: "https://test.cynco.io" });
}

function ok(data: unknown, status = 200) {
  return { ok: true, status, json: async () => ({ success: true, data }) };
}

// ── Timeout ──────────────────────────────────────────────────────────────────

describe("timeout handling", () => {
  it("uses AbortSignal.timeout with configured timeout", async () => {
    const client = new CyncoPay({
      key: "cp_sk_test",
      baseUrl: "https://test.cynco.io",
      timeout: 5000,
    });

    mockFetch.mockResolvedValue(ok({ allowed: true }));
    await client.check("user_1", "feature");

    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeDefined();
    // AbortSignal.timeout returns an AbortSignal
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults timeout to 10 seconds", async () => {
    mockFetch.mockResolvedValue(ok({ allowed: true }));
    await pay().check("user_1", "feature");

    // We can't directly inspect the timeout value on AbortSignal,
    // but we can verify the signal exists
    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeDefined();
  });

  it("propagates AbortError from timeout", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    mockFetch.mockRejectedValue(abortError);

    try {
      await pay().check("user_1", "feature");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    }
  });
});

// ── Network Errors ───────────────────────────────────────────────────────────

describe("network errors", () => {
  it("propagates TypeError from failed fetch (DNS resolution, connection refused)", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    try {
      await pay().subscribe({ customer: "user_1", product: "pro" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect((err as TypeError).message).toBe("Failed to fetch");
    }
  });

  it("propagates generic errors from fetch", async () => {
    mockFetch.mockRejectedValue(new Error("Unexpected error"));

    try {
      await pay().track("user_1", "feature");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Unexpected error");
    }
  });
});

// ── 204 No Content ───────────────────────────────────────────────────────────

describe("204 No Content", () => {
  it("handles 204 responses", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => { throw new Error("No body"); },
    });

    // 204 should return undefined
    const result = await pay().deleteCustomer("user_1");
    expect(result).toBeUndefined();
  });
});

// ── Malformed Responses ──────────────────────────────────────────────────────

describe("malformed responses", () => {
  it("handles success response with no data field", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    try {
      await pay().check("user_1", "feature");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CyncoPayError);
      expect((err as CyncoPayError).code).toBe("EMPTY_RESPONSE");
    }
  });

  it("handles response with success:false and no error object", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false }),
    });

    try {
      await pay().check("user_1", "feature");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CyncoPayError);
      expect((err as CyncoPayError).code).toBe("UNKNOWN");
      expect((err as CyncoPayError).message).toBe("Unknown error");
    }
  });

  it("handles error response that fails to parse as JSON", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    });

    try {
      await pay().cancel("user_1");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CyncoPayError);
      expect((err as CyncoPayError).message).toBe("HTTP 502");
      expect((err as CyncoPayError).code).toBe("REQUEST_FAILED");
      expect((err as CyncoPayError).status).toBe(502);
    }
  });

  it("handles HTML error page from reverse proxy", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    });

    try {
      await pay().analytics();
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CyncoPayError);
      expect((err as CyncoPayError).message).toBe("HTTP 503");
      expect((err as CyncoPayError).status).toBe(503);
    }
  });
});

// ── Paginated Response Format ────────────────────────────────────────────────

describe("paginated response format", () => {
  it("handles response with data array but no success wrapper", async () => {
    // Some list endpoints may return { data: [...], pagination: {...} } directly
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "pprod_1", name: "Pro" }],
        pagination: { total: 1, limit: 20, offset: 0 },
      }),
    });

    const products = await pay().listProducts();
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Pro");
  });

  it("handles standard success-wrapped response for lists", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: [{ id: "pprod_1", name: "Pro" }, { id: "pprod_2", name: "Enterprise" }],
      }),
    });

    const products = await pay().listProducts();
    expect(products).toHaveLength(2);
  });
});

// ── Request Headers ──────────────────────────────────────────────────────────

describe("request headers", () => {
  it("always sends Authorization and Accept headers", async () => {
    mockFetch.mockResolvedValue(ok([]));

    await pay().listProducts();

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer cp_sk_test");
    expect(headers.Accept).toBe("application/json");
  });

  it("sends Content-Type only for POST/PUT/PATCH/DELETE with body", async () => {
    // GET request — no Content-Type
    mockFetch.mockResolvedValue(ok([]));
    await pay().listProducts();
    expect(mockFetch.mock.calls[0][1].headers["Content-Type"]).toBeUndefined();

    // POST request — has Content-Type
    mockFetch.mockResolvedValue(ok({ allowed: true }));
    await pay().check("user_1", "feature");
    expect(mockFetch.mock.calls[1][1].headers["Content-Type"]).toBe("application/json");
  });

  it("sends API version header when configured", async () => {
    const client = new CyncoPay({
      key: "cp_sk_test",
      baseUrl: "https://test.cynco.io",
      apiVersion: "2026-03-19",
    });

    mockFetch.mockResolvedValue(ok({ allowed: true }));
    await client.check("user_1", "feature");

    expect(mockFetch.mock.calls[0][1].headers["X-CyncoPay-Version"]).toBe("2026-03-19");
  });

  it("sends Idempotency-Key header when provided", async () => {
    mockFetch.mockResolvedValue(ok({ action: "activated" }));

    await pay().subscribe(
      { customer: "user_1", product: "pro" },
      { idempotencyKey: "idem_abc123" },
    );

    expect(mockFetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe("idem_abc123");
  });

  it("does not send Idempotency-Key when not provided", async () => {
    mockFetch.mockResolvedValue(ok({ action: "activated" }));

    await pay().subscribe({ customer: "user_1", product: "pro" });

    expect(mockFetch.mock.calls[0][1].headers["Idempotency-Key"]).toBeUndefined();
  });
});

// ── URL Construction ─────────────────────────────────────────────────────────

describe("URL construction", () => {
  it("strips trailing slash from baseUrl", async () => {
    const client = new CyncoPay({
      key: "cp_sk_test",
      baseUrl: "https://test.cynco.io/",
    });

    mockFetch.mockResolvedValue(ok([]));
    await client.listProducts();

    expect(mockFetch.mock.calls[0][0]).toBe("https://test.cynco.io/api/v1/pay/products");
  });

  it("encodes query parameters correctly", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pcm_1" }));

    // Customer ID with special characters
    await pay().getCustomer("user/123&test=true");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("user%2F123%26test%3Dtrue");
  });

  it("builds query string with buildQuery for spend caps", async () => {
    mockFetch.mockResolvedValue(ok({ capCents: 5000 }));

    await pay().getSpendCap("user_1", "api_calls");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("customer=user_1");
    expect(url).toContain("feature=api_calls");
  });

  it("handles pagination params on list methods", async () => {
    mockFetch.mockResolvedValue(ok([]));

    await pay().listProducts({ limit: 10, offset: 20 });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=20");
  });

  it("omits undefined pagination params", async () => {
    mockFetch.mockResolvedValue(ok([]));

    await pay().listProducts({ limit: 5 });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("limit=5");
    expect(url).not.toContain("offset");
  });
});

// ── CyncoPayError ────────────────────────────────────────────────────────────

describe("CyncoPayError", () => {
  it("has correct name property", () => {
    const error = new CyncoPayError("test", "TEST", 400);
    expect(error.name).toBe("CyncoPayError");
    expect(error.message).toBe("test");
    expect(error.code).toBe("TEST");
    expect(error.status).toBe(400);
  });

  it("is instanceof Error", () => {
    const error = new CyncoPayError("test", "TEST", 400);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CyncoPayError);
  });

  it("includes validation details", () => {
    const error = new CyncoPayError("Invalid", "VALIDATION_ERROR", 422, [
      { field: "customer", message: "required" },
      { field: "product", message: "must be a string" },
    ]);

    expect(error.details).toHaveLength(2);
    expect(error.details![0].field).toBe("customer");
  });

  it("works with try/catch type narrowing", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Bad input" },
      }),
    });

    try {
      await pay().subscribe({ customer: "", product: "" });
    } catch (err) {
      if (err instanceof CyncoPayError) {
        // This is the correct type narrowing pattern for SDK consumers
        expect(err.code).toBe("VALIDATION_ERROR");
        expect(err.status).toBe(422);
        return;
      }
    }
    expect.unreachable("Should have caught CyncoPayError");
  });
});

// ── HTTP Methods ─────────────────────────────────────────────────────────────

describe("HTTP methods", () => {
  it("uses GET for list operations", async () => {
    mockFetch.mockResolvedValue(ok([]));
    await pay().listProducts();
    expect(mockFetch.mock.calls[0][1].method).toBe("GET");
  });

  it("uses POST for create operations", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pprod_1" }));
    await pay().createProduct({ name: "Pro", slug: "pro" });
    expect(mockFetch.mock.calls[0][1].method).toBe("POST");
  });

  it("uses PUT for update customer", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pcm_1" }));
    await pay().updateCustomer({ customerId: "user_1", name: "New Name" });
    expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
  });

  it("uses PATCH for update coupon", async () => {
    mockFetch.mockResolvedValue(ok({ id: "pcpn_1" }));
    await pay().updateCoupon("pcpn_1", { name: "Updated" });
    expect(mockFetch.mock.calls[0][1].method).toBe("PATCH");
  });

  it("uses DELETE for revoke/archive operations", async () => {
    mockFetch.mockResolvedValue(ok({ revoked: true }));
    await pay().revokeApiKey("pak_1");
    expect(mockFetch.mock.calls[0][1].method).toBe("DELETE");
  });

  it("GET requests do not have a body", async () => {
    mockFetch.mockResolvedValue(ok([]));
    await pay().listProducts();
    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
  });

  it("DELETE with body sends JSON", async () => {
    mockFetch.mockResolvedValue(ok({ deleted: true }));
    await pay().deleteEntity("org_1", "user_alice");

    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("DELETE");
    expect(options.body).toBeDefined();
    const body = JSON.parse(options.body);
    expect(body.customer).toBe("org_1");
    expect(body.entityId).toBe("user_alice");
  });
});

// ── Serialization ────────────────────────────────────────────────────────────

describe("request body serialization", () => {
  it("serializes nested objects correctly", async () => {
    mockFetch.mockResolvedValue(ok({ action: "checkout" }));

    await pay().subscribe({
      customer: { id: "user_1", email: "jane@example.com", name: "Jane" },
      product: "pro",
      metadata: { source: "pricing_page", campaign: { id: "camp_1" } },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.customer).toEqual({ id: "user_1", email: "jane@example.com", name: "Jane" });
    expect(body.metadata.campaign.id).toBe("camp_1");
  });

  it("omits undefined fields from body", async () => {
    mockFetch.mockResolvedValue(ok({ recorded: true, allowed: true, balance: 99, limit: 100, unlimited: false, duplicate: false }));

    await pay().track("user_1", "api_calls");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // amount and idempotencyKey were not provided, should not be in body
    expect(body).toEqual({ customer: "user_1", feature: "api_calls" });
    expect(Object.keys(body)).toEqual(["customer", "feature"]);
  });

  it("includes null values in body when explicit", async () => {
    mockFetch.mockResolvedValue(ok({ capCents: null, unlimited: true }));

    await pay().setSpendCap({ customer: "user_1", feature: "api_calls", capCents: null });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.capCents).toBeNull();
  });
});
