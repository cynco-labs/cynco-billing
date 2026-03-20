import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import {
  CyncoPayProvider,
  useCyncoPay,
  useListPlans,
  useAggregateEvents,
  useSubscriptions,
  useBalance,
  useEntity,
  usePricingTable,
  useValidateCoupon,
  usePortal,
} from "../react.js";

// ── Test Helpers ─────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  // Mock window.location with a writable href
  Object.defineProperty(window, "location", {
    value: { href: "https://test.app/" },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
});

function ok(data: unknown, status = 200) {
  return { ok: true, status, json: async () => ({ success: true, data }) };
}

function wrapper(props: { children: ReactNode }) {
  return (
    <CyncoPayProvider
      publishableKey="cp_pk_test"
      customerId="user_1"
      baseUrl="https://test.cynco.io"
    >
      {props.children}
    </CyncoPayProvider>
  );
}

function wrapperWithPrefetch(props: { children: ReactNode }) {
  return (
    <CyncoPayProvider
      publishableKey="cp_pk_test"
      customerId="user_1"
      baseUrl="https://test.cynco.io"
      prefetch={["api_calls", "sso"]}
    >
      {props.children}
    </CyncoPayProvider>
  );
}

function wrapperWithAsyncCustomer(props: { children: ReactNode }) {
  return (
    <CyncoPayProvider
      publishableKey="cp_pk_test"
      customerId={async () => "async_user"}
      baseUrl="https://test.cynco.io"
    >
      {props.children}
    </CyncoPayProvider>
  );
}

// ── CyncoPayProvider ─────────────────────────────────────────────────────────

describe("CyncoPayProvider", () => {
  it("provides context with string customer ID", async () => {
    const { result } = renderHook(() => useCyncoPay(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.customerId).toBe("user_1");
    expect(result.current.client).toBeDefined();
    expect(result.current.entitlements).toBeInstanceOf(Map);
  });

  it("resolves async customer ID", async () => {
    const { result } = renderHook(() => useCyncoPay(), {
      wrapper: wrapperWithAsyncCustomer,
    });

    // Initially loading
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.customerId).toBe("async_user");
  });

  it("prefetches entitlements on mount", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ allowed: true, balance: 9500, limit: 10000, unlimited: false, overageAllowed: false }))
      .mockResolvedValueOnce(ok({ allowed: true, balance: null, limit: null, unlimited: false, overageAllowed: false }));

    const { result } = renderHook(() => useCyncoPay(), {
      wrapper: wrapperWithPrefetch,
    });

    await waitFor(() => {
      expect(result.current.entitlements.size).toBe(2);
    });

    expect(result.current.entitlements.get("api_calls")?.allowed).toBe(true);
    expect(result.current.entitlements.get("api_calls")?.balance).toBe(9500);
    expect(result.current.entitlements.get("sso")?.allowed).toBe(true);
  });
});

// ── useCyncoPay — throws outside provider ────────────────────────────────────

describe("useCyncoPay", () => {
  it("throws when used outside CyncoPayProvider", () => {
    // Suppress console.error from React's error boundary
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      renderHook(() => useCyncoPay());
    }).toThrow("must be used within <CyncoPayProvider>");

    spy.mockRestore();
  });
});

// ── check (context) ──────────────────────────────────────────────────────────

describe("check (context)", () => {
  it("returns denied default for uncached features and fetches async", async () => {
    mockFetch.mockResolvedValue(
      ok({ allowed: true, balance: 500, limit: 1000, granted: 1000, usage: 500, unlimited: false, overageAllowed: false }),
    );

    const { result } = renderHook(() => useCyncoPay(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // First call — cache miss, returns denied
    const initial = result.current.check("new_feature");
    expect(initial.allowed).toBe(false);
    expect(initial.balance).toBeNull();

    // Wait for async fetch to populate cache
    await waitFor(() => {
      expect(result.current.entitlements.has("new_feature")).toBe(true);
    });

    expect(result.current.entitlements.get("new_feature")?.allowed).toBe(true);
    expect(result.current.entitlements.get("new_feature")?.balance).toBe(500);
  });

  it("returns cached result for known features", async () => {
    mockFetch.mockResolvedValue(
      ok({ allowed: true, balance: 100, limit: 200, unlimited: false, overageAllowed: false }),
    );

    const { result } = renderHook(() => useCyncoPay(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Trigger a cache miss to populate
    result.current.check("cached_feature");

    await waitFor(() => {
      expect(result.current.entitlements.has("cached_feature")).toBe(true);
    });

    // Second call — should return cached (no additional fetch)
    const fetchCountBefore = mockFetch.mock.calls.length;
    const cached = result.current.check("cached_feature");
    expect(cached.allowed).toBe(true);
    expect(cached.balance).toBe(100);
    // No additional fetch triggered
    expect(mockFetch.mock.calls.length).toBe(fetchCountBefore);
  });
});

// ── subscribe (context) ──────────────────────────────────────────────────────

describe("subscribe (context)", () => {
  it("calls API with customer and product", async () => {
    mockFetch.mockResolvedValue(
      ok({ action: "activated", subscription: { id: "psub_1", status: "active" } }),
    );

    const { result } = renderHook(() => useCyncoPay(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    let subscribeResult: unknown;
    await act(async () => {
      subscribeResult = await result.current.subscribe("pro", {
        successUrl: "/thanks",
      });
    });

    expect((subscribeResult as { action: string }).action).toBe("activated");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.customer).toBe("user_1");
    expect(body.product).toBe("pro");
    expect(body.successUrl).toBe("/thanks");
  });

  it("redirects on checkout action", async () => {
    mockFetch.mockResolvedValue(
      ok({ action: "checkout", url: "https://checkout.example/pay" }),
    );

    const { result } = renderHook(() => useCyncoPay(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.subscribe("pro");
    });

    expect(window.location.href).toBe("https://checkout.example/pay");
  });

  it("throws before customer is resolved", async () => {
    const { result } = renderHook(() => useCyncoPay(), {
      wrapper: wrapperWithAsyncCustomer,
    });

    // Customer is still resolving
    expect(result.current.loading).toBe(true);

    await expect(
      result.current.subscribe("pro"),
    ).rejects.toThrow("Customer not resolved yet");
  });

  it("passes couponCode and fingerprint", async () => {
    mockFetch.mockResolvedValue(ok({ action: "checkout", url: "https://checkout.example/pay" }));

    const { result } = renderHook(() => useCyncoPay(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.subscribe("pro", {
        couponCode: "SAVE20",
        fingerprint: "fp_abc",
      });
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.couponCode).toBe("SAVE20");
    expect(body.fingerprint).toBe("fp_abc");
  });
});

// ── track (context) ──────────────────────────────────────────────────────────

describe("track (context)", () => {
  it("calls API and updates entitlement cache", async () => {
    mockFetch.mockResolvedValue(
      ok({ recorded: true, allowed: true, balance: 99, limit: 100, unlimited: false, duplicate: false }),
    );

    const { result } = renderHook(() => useCyncoPay(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    let trackResult: unknown;
    await act(async () => {
      trackResult = await result.current.track("api_calls", { amount: 1 });
    });

    expect((trackResult as { recorded: boolean }).recorded).toBe(true);

    // Cache should be updated
    const cached = result.current.entitlements.get("api_calls");
    expect(cached?.balance).toBe(99);
    expect(cached?.allowed).toBe(true);
  });

  it("throws before customer is resolved", async () => {
    const { result } = renderHook(() => useCyncoPay(), {
      wrapper: wrapperWithAsyncCustomer,
    });

    await expect(
      result.current.track("api_calls"),
    ).rejects.toThrow("Customer not resolved yet");
  });
});

// ── refresh ──────────────────────────────────────────────────────────────────

describe("refresh", () => {
  it("re-fetches all cached entitlements", async () => {
    // First fetch for prefetch
    mockFetch
      .mockResolvedValueOnce(ok({ allowed: true, balance: 100, limit: 200, unlimited: false, overageAllowed: false }))
      .mockResolvedValueOnce(ok({ allowed: true, balance: null, limit: null, unlimited: false, overageAllowed: false }));

    const { result } = renderHook(() => useCyncoPay(), {
      wrapper: wrapperWithPrefetch,
    });

    await waitFor(() => {
      expect(result.current.entitlements.size).toBe(2);
    });

    // Mock updated responses for refresh
    mockFetch
      .mockResolvedValueOnce(ok({ allowed: true, balance: 50, limit: 200, unlimited: false, overageAllowed: false }))
      .mockResolvedValueOnce(ok({ allowed: false, balance: null, limit: null, unlimited: false, overageAllowed: false }));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.entitlements.get("api_calls")?.balance).toBe(50);
    expect(result.current.entitlements.get("sso")?.allowed).toBe(false);
  });
});

// ── useListPlans ─────────────────────────────────────────────────────────────

describe("useListPlans", () => {
  it("fetches plans with customer eligibility", async () => {
    mockFetch.mockResolvedValue(
      ok([
        {
          id: "pprod_1",
          name: "Pro",
          slug: "pro",
          description: null,
          isDefault: false,
          isAddOn: false,
          sortOrder: 1,
          prices: [{ id: "ppri_1", amount: 2000, currency: "MYR", billingInterval: "month" }],
          features: [{ slug: "api_calls", name: "API Calls", allowanceType: "fixed", allowance: 10000 }],
          customerEligibility: { scenario: "new", currentSubscriptionId: null, prorationAmount: null, trialAvailable: true },
        },
      ]),
    );

    const { result } = renderHook(() => useListPlans(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].slug).toBe("pro");
    expect(result.current.data![0].customerEligibility?.scenario).toBe("new");
  });

  it("supports refetch", async () => {
    mockFetch.mockResolvedValue(ok([]));

    const { result } = renderHook(() => useListPlans(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Refetch
    mockFetch.mockResolvedValue(ok([{ id: "pprod_2", slug: "enterprise" }]));

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
    });

    expect(result.current.data![0].slug).toBe("enterprise");
  });
});

// ── useAggregateEvents ───────────────────────────────────────────────────────

describe("useAggregateEvents", () => {
  it("fetches usage timeline", async () => {
    mockFetch.mockResolvedValue(
      ok({
        timeline: [
          { period: "2026-03-01", count: 150, total: 150 },
          { period: "2026-03-02", count: 200, total: 200 },
        ],
        total: { count: 350, sum: 350 },
      }),
    );

    const { result } = renderHook(
      () => useAggregateEvents({ feature: "api_calls", range: "7d", groupBy: "day" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.timeline).toHaveLength(2);
    expect(result.current.total?.count).toBe(350);
    expect(result.current.total?.sum).toBe(350);
  });
});

// ── useSubscriptions ─────────────────────────────────────────────────────────

describe("useSubscriptions", () => {
  it("fetches subscriptions from customer state", async () => {
    mockFetch.mockResolvedValue(
      ok({
        id: "pcm_1",
        externalId: "user_1",
        environment: "test",
        subscriptions: [
          { id: "psub_1", status: "active", productSlug: "pro", currentPeriodStart: "2026-03-01", currentPeriodEnd: "2026-04-01", cancelAtPeriodEnd: false, quantity: 1 },
          { id: "psub_2", status: "trialing", productSlug: "addon", currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, quantity: 1 },
        ],
        balances: {},
        flags: {},
        paymentMethods: [],
      }),
    );

    const { result } = renderHook(() => useSubscriptions(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.subscriptions).toHaveLength(2);
    expect(result.current.subscriptions[0].productSlug).toBe("pro");
    expect(result.current.subscriptions[1].status).toBe("trialing");
  });

  it("supports refresh", async () => {
    mockFetch.mockResolvedValue(
      ok({ id: "pcm_1", externalId: "user_1", subscriptions: [{ id: "psub_1", status: "active", productSlug: "pro" }], balances: {}, flags: {}, paymentMethods: [] }),
    );

    const { result } = renderHook(() => useSubscriptions(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Refresh with updated data
    mockFetch.mockResolvedValue(
      ok({ id: "pcm_1", externalId: "user_1", subscriptions: [{ id: "psub_1", status: "canceled", productSlug: "pro" }], balances: {}, flags: {}, paymentMethods: [] }),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.subscriptions[0].status).toBe("canceled");
  });
});

// ── useBalance ───────────────────────────────────────────────────────────────

describe("useBalance", () => {
  it("shows loading for uncached features", () => {
    const { result } = renderHook(() => useBalance("unknown_feature"), {
      wrapper,
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.balance).toBeNull();
  });

  it("returns cached balance after prefetch", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ allowed: true, balance: 9500, limit: 10000, granted: 10000, usage: 500, unlimited: false, overageAllowed: false }))
      .mockResolvedValueOnce(ok({ allowed: true, balance: null, limit: null, granted: null, usage: null, unlimited: false, overageAllowed: false }));

    const { result } = renderHook(() => useBalance("api_calls"), {
      wrapper: wrapperWithPrefetch,
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.balance).toBe(9500);
    expect(result.current.granted).toBe(10000);
    expect(result.current.unlimited).toBe(false);
  });

  it("returns unlimited flag", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ allowed: true, balance: null, limit: null, granted: null, usage: null, unlimited: true, overageAllowed: false }))
      .mockResolvedValueOnce(ok({ allowed: true, balance: null, limit: null, granted: null, usage: null, unlimited: false, overageAllowed: false }));

    const { result } = renderHook(() => useBalance("api_calls"), {
      wrapper: wrapperWithPrefetch,
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.unlimited).toBe(true);
    expect(result.current.balance).toBeNull();
  });
});

// ── useEntity ────────────────────────────────────────────────────────────────

describe("useEntity", () => {
  it("provides entity-scoped check", async () => {
    mockFetch.mockResolvedValue(
      ok({ allowed: true, balance: 50, limit: 100, unlimited: false, overageAllowed: false }),
    );

    const { result } = renderHook(() => useEntity("ws_abc"), { wrapper });

    await waitFor(() => expect(result.current.check).toBeDefined());

    let checkResult: unknown;
    await act(async () => {
      checkResult = await result.current.check("workspace_access");
    });

    expect((checkResult as { allowed: boolean }).allowed).toBe(true);
    expect((checkResult as { balance: number }).balance).toBe(50);

    // Verify entityId was sent
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.entityId).toBe("ws_abc");
  });

  it("provides entity-scoped track", async () => {
    mockFetch.mockResolvedValue(
      ok({ recorded: true, allowed: true, balance: 49, limit: 100, unlimited: false, duplicate: false }),
    );

    const { result } = renderHook(() => useEntity("ws_abc"), { wrapper });

    await act(async () => {
      await result.current.track("ai_messages", 1);
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.entityId).toBe("ws_abc");
    expect(body.amount).toBe(1);
  });

  it("returns denied when customer not resolved", async () => {
    const { result } = renderHook(() => useEntity("ws_abc"), {
      wrapper: wrapperWithAsyncCustomer,
    });

    const checkResult = await result.current.check("feature");
    expect(checkResult.allowed).toBe(false);
    expect(checkResult.balance).toBeNull();
  });
});

// ── usePricingTable ──────────────────────────────────────────────────────────

describe("usePricingTable", () => {
  it("fetches pricing table with formatted prices and groups", async () => {
    mockFetch.mockResolvedValue(
      ok({
        plans: [
          {
            id: "pprod_1",
            name: "Pro",
            slug: "pro",
            description: null,
            isDefault: false,
            isAddOn: false,
            sortOrder: 1,
            prices: [{ id: "ppri_1", amount: 2000, amountFormatted: "MYR 20.00", currency: "MYR", billingInterval: "month", trialDays: 14 }],
            features: [{ slug: "api_calls", name: "API Calls", allowance: 10000, unlimited: false }],
          },
        ],
        groups: [{ slug: "main", planCount: 3 }],
      }),
    );

    const { result } = renderHook(() => usePricingTable(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.plans).toHaveLength(1);
    expect(result.current.plans[0].prices[0].amountFormatted).toBe("MYR 20.00");
    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].slug).toBe("main");
  });

  it("waits for customer resolution before fetching", async () => {
    mockFetch.mockResolvedValue(ok({ plans: [], groups: [] }));

    const { result } = renderHook(() => usePricingTable(), {
      wrapper: wrapperWithAsyncCustomer,
    });

    // Initially loading — should NOT have fired any fetch yet
    expect(result.current.loading).toBe(true);

    // Wait for customer to resolve, then pricing table to load
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Now verify the fetch happened with the resolved customer
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("pricing-table");
    expect(url).toContain("customer=async_user");
  });
});

// ── useValidateCoupon ────────────────────────────────────────────────────────

describe("useValidateCoupon", () => {
  it("validates a coupon with amount", async () => {
    mockFetch.mockResolvedValue(
      ok({ valid: true, discountAmount: 400, finalAmount: 1600, couponType: "percentage", duration: "once" }),
    );

    const { result } = renderHook(() => useValidateCoupon(), { wrapper });

    await act(async () => {
      await result.current.validate("SAVE20", "pro", 2000);
    });

    expect(result.current.result?.valid).toBe(true);
    expect(result.current.result?.discountAmount).toBe(400);
    expect(result.current.result?.finalAmount).toBe(1600);

    // Verify amount was sent in request
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.amount).toBe(2000);
    expect(body.code).toBe("SAVE20");
    expect(body.product).toBe("pro");
    expect(body.customer).toBe("user_1");
  });

  it("shows invalid result on error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useValidateCoupon(), { wrapper });

    await act(async () => {
      await result.current.validate("BAD", "pro", 1000);
    });

    expect(result.current.result?.valid).toBe(false);
    expect(result.current.result?.message).toBe("Network error");
  });

  it("shows loading state during validation", async () => {
    let resolvePromise: (value: unknown) => void;
    mockFetch.mockReturnValue(
      new Promise((resolve) => { resolvePromise = resolve; }),
    );

    const { result } = renderHook(() => useValidateCoupon(), { wrapper });

    expect(result.current.loading).toBe(false);

    // Start validation
    let validatePromise: Promise<void>;
    act(() => {
      validatePromise = result.current.validate("SAVE20", "pro", 2000);
    });

    expect(result.current.loading).toBe(true);

    // Resolve
    await act(async () => {
      resolvePromise!(ok({ valid: true, discountAmount: 200, finalAmount: 800 }));
      await validatePromise!;
    });

    expect(result.current.loading).toBe(false);
  });
});

// ── usePortal ────────────────────────────────────────────────────────────────

describe("usePortal", () => {
  it("generates portal URL and redirects", async () => {
    mockFetch.mockResolvedValue(
      ok({ url: "https://app.cynco.io/portal/billing?token=abc123" }),
    );

    const { result } = renderHook(() => usePortal(), { wrapper });

    expect(result.current.portalUrl).toBeNull();

    await act(async () => {
      await result.current.openPortal();
    });

    expect(result.current.portalUrl).toBe("https://app.cynco.io/portal/billing?token=abc123");
    expect(window.location.href).toBe("https://app.cynco.io/portal/billing?token=abc123");

    // Verify the request included customer
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("customer=user_1");
  });
});

// ── Prefetch merging ─────────────────────────────────────────────────────────

describe("prefetch merging", () => {
  it("merges prefetched entitlements with ad-hoc checks", async () => {
    // Prefetch returns two features
    mockFetch
      .mockResolvedValueOnce(ok({ allowed: true, balance: 100, limit: 200, unlimited: false, overageAllowed: false }))
      .mockResolvedValueOnce(ok({ allowed: true, balance: null, limit: null, unlimited: false, overageAllowed: false }));

    const { result } = renderHook(() => useCyncoPay(), {
      wrapper: wrapperWithPrefetch,
    });

    await waitFor(() => {
      expect(result.current.entitlements.size).toBe(2);
    });

    // Now do an ad-hoc check for a different feature
    mockFetch.mockResolvedValueOnce(
      ok({ allowed: false, balance: 0, limit: 50, unlimited: false, overageAllowed: false }),
    );

    act(() => {
      result.current.check("extra_feature");
    });

    await waitFor(() => {
      expect(result.current.entitlements.has("extra_feature")).toBe(true);
    });

    // Verify prefetched features are still there (not replaced)
    expect(result.current.entitlements.has("api_calls")).toBe(true);
    expect(result.current.entitlements.has("sso")).toBe(true);
    expect(result.current.entitlements.size).toBe(3);
  });
});
