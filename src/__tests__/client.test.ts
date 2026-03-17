import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CyncoPay, CyncoPayError } from "../client.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("CyncoPay", () => {
  it("throws if key is missing", () => {
    expect(() => new CyncoPay({ key: "" })).toThrow("key is required");
  });

  it("uses default base URL", () => {
    const pay = new CyncoPay({ key: "cp_sk_test" });
    expect(pay).toBeDefined();
  });
});

describe("subscribe", () => {
  it("sends correct request and returns result", async () => {
    const pay = new CyncoPay({ key: "cp_sk_test", baseUrl: "https://test.cynco.io" });

    mockFetch.mockResolvedValue(
      mockResponse({
        success: true,
        data: { action: "checkout", url: "https://chip.example/checkout" },
      }),
    );

    const result = await pay.subscribe({
      customer: { id: "user_1", email: "jane@example.com", name: "Jane" },
      product: "pro",
      successUrl: "https://myapp.com/success",
      cancelUrl: "https://myapp.com/cancel",
    });

    expect(result.action).toBe("checkout");
    expect(result.url).toBe("https://chip.example/checkout");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://test.cynco.io/api/v1/pay/subscribe");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer cp_sk_test");
    expect(JSON.parse(options.body)).toEqual({
      customer: { id: "user_1", email: "jane@example.com", name: "Jane" },
      product: "pro",
      successUrl: "https://myapp.com/success",
      cancelUrl: "https://myapp.com/cancel",
    });
  });
});

describe("check", () => {
  it("sends correct request", async () => {
    const pay = new CyncoPay({ key: "cp_pk_test", baseUrl: "https://test.cynco.io" });

    mockFetch.mockResolvedValue(
      mockResponse({
        success: true,
        data: { allowed: true, balance: 950, limit: 1000, unlimited: false },
      }),
    );

    const result = await pay.check("user_1", "api_calls");

    expect(result.allowed).toBe(true);
    expect(result.balance).toBe(950);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ customer: "user_1", feature: "api_calls" });
  });
});

describe("track", () => {
  it("sends correct request with options", async () => {
    const pay = new CyncoPay({ key: "cp_sk_test", baseUrl: "https://test.cynco.io" });

    mockFetch.mockResolvedValue(
      mockResponse({
        success: true,
        data: { recorded: true, allowed: true, balance: 99, limit: 100, unlimited: false, duplicate: false },
      }),
    );

    const result = await pay.track("user_1", "api_calls", {
      amount: 1,
      idempotencyKey: "req_abc",
    });

    expect(result.recorded).toBe(true);
    expect(result.balance).toBe(99);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      customer: "user_1",
      feature: "api_calls",
      amount: 1,
      idempotencyKey: "req_abc",
    });
  });

  it("defaults amount when omitted", async () => {
    const pay = new CyncoPay({ key: "cp_sk_test", baseUrl: "https://test.cynco.io" });

    mockFetch.mockResolvedValue(
      mockResponse({ success: true, data: { recorded: true, allowed: true, balance: 99, limit: 100, unlimited: false, duplicate: false } }),
    );

    await pay.track("user_1", "api_calls");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ customer: "user_1", feature: "api_calls" });
  });
});

describe("cancel", () => {
  it("sends correct request", async () => {
    const pay = new CyncoPay({ key: "cp_sk_test", baseUrl: "https://test.cynco.io" });

    mockFetch.mockResolvedValue(
      mockResponse({
        success: true,
        data: { canceled: true, effectiveAt: "2026-04-01T00:00:00Z" },
      }),
    );

    const result = await pay.cancel("user_1", { product: "pro", immediate: false });

    expect(result.canceled).toBe(true);
    expect(result.effectiveAt).toBe("2026-04-01T00:00:00Z");
  });
});

describe("error handling", () => {
  it("throws CyncoPayError on 4xx", async () => {
    const pay = new CyncoPay({ key: "cp_sk_test", baseUrl: "https://test.cynco.io" });

    mockFetch.mockResolvedValue(
      mockResponse(
        {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Invalid input", details: [{ field: "product", message: "Required" }] },
        },
        422,
      ),
    );

    try {
      await pay.subscribe({ customer: "user_1", product: "" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CyncoPayError);
      const payErr = err as CyncoPayError;
      expect(payErr.code).toBe("VALIDATION_ERROR");
      expect(payErr.status).toBe(422);
      expect(payErr.details).toHaveLength(1);
      expect(payErr.details![0].field).toBe("product");
    }
  });

  it("throws CyncoPayError on 401", async () => {
    const pay = new CyncoPay({ key: "cp_sk_invalid", baseUrl: "https://test.cynco.io" });

    mockFetch.mockResolvedValue(
      mockResponse(
        { success: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
        401,
      ),
    );

    try {
      await pay.check("user_1", "feature");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CyncoPayError);
      expect((err as CyncoPayError).code).toBe("UNAUTHORIZED");
    }
  });

  it("handles non-JSON error responses", async () => {
    const pay = new CyncoPay({ key: "cp_sk_test", baseUrl: "https://test.cynco.io" });

    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json"); },
    });

    try {
      await pay.check("user_1", "feature");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CyncoPayError);
      expect((err as CyncoPayError).message).toBe("HTTP 500");
    }
  });
});

describe("listProducts", () => {
  it("sends GET request", async () => {
    const pay = new CyncoPay({ key: "cp_sk_test", baseUrl: "https://test.cynco.io" });

    mockFetch.mockResolvedValue(
      mockResponse({ success: true, data: [{ id: "pprod_1", name: "Pro" }] }),
    );

    const products = await pay.listProducts();
    expect(products).toHaveLength(1);
    expect(mockFetch.mock.calls[0][1].method).toBe("GET");
  });
});
