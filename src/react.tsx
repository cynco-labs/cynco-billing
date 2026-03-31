import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { CyncoBilling, CyncoBillingError } from "./client.js";
import type {
  CheckResult,
  SubscribeResult,
  TrackResult,
  SubscribeInput,
  PricingTableResponse,
  PricingTablePlan,
  CouponValidation,
  Plan,
  CustomerEligibility,
  SubscriptionSummary,
  UsageTimelineEntry,
  UsageAggregation,
} from "./types.js";

// ── Context ──────────────────────────────────────────────────────────────────

interface CyncoBillingContextValue {
  client: CyncoBilling;
  customerId: string | null;
  loading: boolean;
  error: CyncoBillingError | null;
  entitlements: Map<string, CheckResult>;

  /** Subscribe the current customer to a product. */
  subscribe: (
    product: string,
    options?: Omit<SubscribeInput, "customer" | "product">,
  ) => Promise<SubscribeResult>;

  /** Check if the current customer has access to a feature. Reads from cache first. */
  check: (feature: string) => CheckResult;

  /** Track usage for the current customer. */
  track: (
    feature: string,
    options?: { amount?: number; idempotencyKey?: string },
  ) => Promise<TrackResult>;

  /** Refresh entitlements from the server. */
  refresh: () => Promise<void>;
}

const CyncoBillingContext = createContext<CyncoBillingContextValue | null>(null);

function usePayContext(): CyncoBillingContextValue {
  const ctx = useContext(CyncoBillingContext);
  if (!ctx) throw new Error("Cynco Billing hooks must be used within <CyncoBillingProvider>");
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────────────

interface CyncoBillingProviderProps {
  /** Publishable key (cp_pk_...) or secret key (cp_sk_... — only for SSR). */
  publishableKey: string;
  /** API base URL. Defaults to https://app.cynco.io */
  baseUrl?: string;
  /** Resolves the current user's external customer ID. Called once on mount. */
  customerId: string | (() => string | Promise<string>);
  /** Features to prefetch on mount. */
  prefetch?: string[];
  children: ReactNode;
}

export function CyncoBillingProvider({
  publishableKey,
  baseUrl,
  customerId: customerIdProp,
  prefetch,
  children,
}: CyncoBillingProviderProps) {
  const client = useMemo(
    () => new CyncoBilling({ key: publishableKey, baseUrl }),
    [publishableKey, baseUrl],
  );

  const [customerId, setCustomerId] = useState<string | null>(
    typeof customerIdProp === "string" ? customerIdProp : null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CyncoBillingError | null>(null);
  const [entitlements, setEntitlements] = useState<Map<string, CheckResult>>(
    new Map(),
  );
  const pendingChecks = useRef(new Set<string>());
  const entitlementsRef = useRef(entitlements);
  useEffect(() => { entitlementsRef.current = entitlements; }, [entitlements]);

  // Stabilize prefetch array to avoid re-fetching on every render
  const prefetchKey = prefetch ? JSON.stringify(prefetch) : "";

  // Resolve customer ID — reset entitlements when customer changes
  useEffect(() => {
    if (typeof customerIdProp === "string") {
      setCustomerId((prev) => {
        if (prev !== customerIdProp) {
          setEntitlements(new Map());
          pendingChecks.current = new Set();
        }
        return customerIdProp;
      });
      setLoading(false);
      return;
    }
    let cancelled = false;
    Promise.resolve(customerIdProp()).then((id) => {
      if (!cancelled) {
        setCustomerId((prev) => {
          if (prev !== id) {
            setEntitlements(new Map());
            pendingChecks.current = new Set();
          }
          return id;
        });
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [customerIdProp]);

  // Prefetch entitlements (merges into existing map)
  useEffect(() => {
    if (!customerId || !prefetch?.length) return;
    let cancelled = false;

    Promise.all(
      prefetch.map(async (feature) => {
        const result = await client.check(customerId, feature);
        return [feature, result] as const;
      }),
    )
      .then((results) => {
        if (cancelled) return;
        setEntitlements((prev) => new Map([...prev, ...results]));
      })
      .catch((err) => {
        if (!cancelled && err instanceof CyncoBillingError) setError(err);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, customerId, prefetchKey]);

  const subscribe = useCallback(
    async (
      product: string,
      options?: Omit<SubscribeInput, "customer" | "product">,
    ): Promise<SubscribeResult> => {
      if (!customerId) throw new Error("Customer not resolved yet");
      const result = await client.subscribe({
        customer: customerId,
        product,
        ...options,
      });
      // If checkout, redirect
      if (result.action === "checkout" && result.url) {
        window.location.href = result.url;
      }
      return result;
    },
    [client, customerId],
  );

  const check = useCallback(
    (feature: string): CheckResult => {
      const cached = entitlementsRef.current.get(feature);
      if (cached) return cached;
      // Not cached — return denied, trigger async fetch (deduplicated)
      if (customerId && !pendingChecks.current.has(feature)) {
        pendingChecks.current.add(feature);
        client
          .check(customerId, feature)
          .then((result) => {
            setEntitlements((prev) => {
              const next = new Map(prev);
              next.set(feature, result);
              return next;
            });
          })
          .catch(() => {})
          .finally(() => {
            pendingChecks.current.delete(feature);
          });
      }
      return { allowed: false, balance: null, limit: null, granted: null, usage: null, unlimited: false, overageAllowed: false };
    },
    [client, customerId],
  );

  const track = useCallback(
    async (
      feature: string,
      options?: { amount?: number; idempotencyKey?: string },
    ): Promise<TrackResult> => {
      if (!customerId) throw new Error("Customer not resolved yet");
      const result = await client.track(customerId, feature, options);
      // Update cached entitlement
      if (result.balance !== null) {
        setEntitlements((prev) => {
          const next = new Map(prev);
          next.set(feature, {
            allowed: result.allowed,
            balance: result.balance,
            limit: result.limit,
            granted: null,
            usage: null,
            unlimited: result.unlimited,
            overageAllowed: false,
          });
          return next;
        });
      }
      return result;
    },
    [client, customerId],
  );

  const refresh = useCallback(async () => {
    if (!customerId) return;
    const features = Array.from(entitlementsRef.current.keys());
    if (features.length === 0) return;

    try {
      const results = await Promise.all(
        features.map(async (feature) => {
          const result = await client.check(customerId, feature);
          return [feature, result] as const;
        }),
      );
      setEntitlements((prev) => new Map([...prev, ...results]));
    } catch {
      // non-fatal — keep existing entitlements
    }
  }, [client, customerId]);

  const value = useMemo<CyncoBillingContextValue>(
    () => ({
      client,
      customerId,
      loading,
      error,
      entitlements,
      subscribe,
      check,
      track,
      refresh,
    }),
    [client, customerId, loading, error, entitlements, subscribe, check, track, refresh],
  );

  return (
    <CyncoBillingContext.Provider value={value}>
      {children}
    </CyncoBillingContext.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Access Cynco Billing from any component.
 *
 * ```tsx
 * function PricingPage() {
 *   const { subscribe, check } = useCyncoBilling();
 *   const isPro = check("premium").allowed;
 *
 *   return (
 *     <button onClick={() => subscribe("pro", { successUrl: "/welcome" })}>
 *       {isPro ? "Current Plan" : "Upgrade to Pro"}
 *     </button>
 *   );
 * }
 * ```
 */
export function useCyncoBilling(): CyncoBillingContextValue {
  return usePayContext();
}

// ── useListPlans ─────────────────────────────────────────────────────────────

/**
 * List plans with customer eligibility context.
 * Automatically includes the current customer's context from CyncoBillingProvider.
 *
 * ```tsx
 * function PricingPage() {
 *   const { data: plans } = useListPlans();
 *   const { subscribe } = useCyncoBilling();
 *
 *   return plans?.map((plan) => (
 *     <button
 *       key={plan.id}
 *       disabled={plan.customerEligibility?.scenario === "active"}
 *       onClick={() => subscribe(plan.slug)}
 *     >
 *       {plan.customerEligibility?.scenario === "active" ? "Current" : plan.name}
 *     </button>
 *   ));
 * }
 * ```
 */
export function useListPlans(): {
  data: Plan[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const ctx = usePayContext();

  const [data, setData] = useState<Plan[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const fetchRef = useRef(0);

  const fetchPlans = useCallback(() => {
    const id = ++fetchRef.current;
    setLoading(true);
    ctx.client
      .listPlans(ctx.customerId ?? undefined)
      .then((plans) => {
        if (fetchRef.current === id) {
          setData(plans);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (fetchRef.current === id) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });
  }, [ctx.client, ctx.customerId]);

  useEffect(() => {
    if (ctx.customerId !== null || ctx.loading === false) {
      fetchPlans();
    }
  }, [fetchPlans, ctx.loading]);

  return { data, loading, error, refetch: fetchPlans };
}

// ── useAggregateEvents ───────────────────────────────────────────────────────

/**
 * Aggregate usage events for the current customer over a time range.
 *
 * ```tsx
 * const { timeline, total } = useAggregateEvents({ feature: "api_calls", range: "30d" });
 * // Pass timeline to a chart component
 * ```
 */
export function useAggregateEvents(options: {
  feature: string;
  range?: "7d" | "14d" | "30d" | "90d" | "365d";
  groupBy?: "day" | "week" | "month";
}): {
  timeline: UsageTimelineEntry[] | null;
  total: UsageAggregation["total"] | null;
  loading: boolean;
} {
  const ctx = usePayContext();

  const [timeline, setTimeline] = useState<UsageTimelineEntry[] | null>(null);
  const [total, setTotal] = useState<UsageAggregation["total"] | null>(null);
  const [loading, setLoading] = useState(true);

  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    if (!ctx.customerId) return;
    let cancelled = false;

    ctx.client
      .aggregateEvents(ctx.customerId, options.feature, {
        range: options.range,
        groupBy: options.groupBy,
      })
      .then((result) => {
        if (!cancelled) {
          setTimeline(result.timeline);
          setTotal(result.total);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.client, ctx.customerId, optionsKey]);

  return { timeline, total, loading };
}

// ── useSubscriptions ──────────────────────────────────────────────────────────

/**
 * Returns the current customer's subscriptions.
 *
 * ```tsx
 * function AccountPage() {
 *   const { subscriptions, loading } = useSubscriptions();
 *   if (loading) return <Spinner />;
 *   return subscriptions.map((s) => <div key={s.id}>{s.productSlug} — {s.status}</div>);
 * }
 * ```
 */
export function useSubscriptions(): {
  subscriptions: SubscriptionSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const ctx = usePayContext();

  const [subscriptions, setSubscriptions] = useState<SubscriptionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(0);

  const fetchSubscriptions = useCallback(async () => {
    if (!ctx.customerId) return;
    const id = ++fetchRef.current;
    setLoading(true);

    try {
      const customer = await ctx.client.getCustomer(ctx.customerId);
      if (fetchRef.current !== id) return;

      if (Array.isArray(customer.subscriptions)) {
        setSubscriptions(customer.subscriptions);
      }
    } catch {
      // non-fatal — keep stale data
    } finally {
      if (fetchRef.current === id) setLoading(false);
    }
  }, [ctx.client, ctx.customerId]);

  useEffect(() => {
    if (ctx.customerId) {
      void fetchSubscriptions();
    } else if (!ctx.loading) {
      setLoading(false);
    }
  }, [fetchSubscriptions, ctx.customerId, ctx.loading]);

  return { subscriptions, loading, refresh: fetchSubscriptions };
}

// ── useBalance ────────────────────────────────────────────────────────────────

/**
 * Returns the balance for a specific feature.
 * Reads from the cached entitlements (populated by prefetch or check calls).
 *
 * ```tsx
 * function UsageBar({ feature }: { feature: string }) {
 *   const { balance, granted, unlimited, loading } = useBalance(feature);
 *   if (loading || unlimited) return <span>Unlimited</span>;
 *   return <ProgressBar value={balance ?? 0} max={granted ?? 0} />;
 * }
 * ```
 */
export function useBalance(featureId: string): {
  balance: number | null;
  granted: number | null;
  usage: number | null;
  unlimited: boolean;
  overageAllowed: boolean;
  loading: boolean;
} {
  const ctx = usePayContext();

  useEffect(() => {
    if (ctx.customerId) {
      ctx.check(featureId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId, ctx.customerId]); // re-fetch when customer resolves or changes

  const cached = ctx.entitlements.get(featureId);
  return {
    balance: cached?.balance ?? null,
    granted: cached?.granted ?? null,
    usage: cached?.usage ?? null,
    unlimited: cached?.unlimited ?? false,
    overageAllowed: cached?.overageAllowed ?? false,
    loading: ctx.loading || !ctx.entitlements.has(featureId),
  };
}

// ── useEntity ─────────────────────────────────────────────────────────────────

/**
 * Returns entity-scoped check and track functions.
 * Use for per-seat, per-workspace, or per-project billing.
 *
 * ```tsx
 * function WorkspaceGuard({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
 *   const { check } = useEntity(workspaceId);
 *   const [allowed, setAllowed] = useState(false);
 *
 *   useEffect(() => {
 *     check("workspace_access").then((r) => setAllowed(r.allowed));
 *   }, [check]);
 *
 *   return allowed ? children : <UpgradePrompt />;
 * }
 * ```
 */
export function useEntity(entityId: string): {
  check: (featureId: string) => Promise<{ allowed: boolean; balance: number | null }>;
  track: (featureId: string, amount?: number) => Promise<void>;
} {
  const ctx = usePayContext();

  const check = useCallback(
    async (featureId: string): Promise<{ allowed: boolean; balance: number | null }> => {
      if (!ctx.customerId) {
        return { allowed: false, balance: null };
      }
      const result = await ctx.client.check(ctx.customerId, featureId, { entityId });
      return { allowed: result.allowed, balance: result.balance };
    },
    [ctx.client, ctx.customerId, entityId],
  );

  const track = useCallback(
    async (featureId: string, amount?: number): Promise<void> => {
      if (!ctx.customerId) return;
      await ctx.client.track(ctx.customerId, featureId, { amount, entityId });
    },
    [ctx.client, ctx.customerId, entityId],
  );

  return { check, track };
}

// ── usePricingTable ──────────────────────────────────────────────────────────

/**
 * Fetch the pricing table for embedding in marketing sites.
 * Uses the dedicated pricing table API endpoint with pre-formatted prices.
 *
 * ```tsx
 * function PricingTable() {
 *   const { plans, groups, loading } = usePricingTable();
 *   if (loading) return <Spinner />;
 *   return <PricingGrid plans={plans} groups={groups} />;
 * }
 * ```
 */
export function usePricingTable(): {
  plans: PricingTablePlan[];
  groups: { slug: string; planCount: number }[];
  loading: boolean;
  error: Error | null;
} {
  const ctx = usePayContext();
  const [plans, setPlans] = useState<PricingTablePlan[]>([]);
  const [groups, setGroups] = useState<{ slug: string; planCount: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // Wait for customer resolution to avoid a wasted unauthenticated fetch
    if (ctx.loading) return;
    let cancelled = false;

    ctx.client.getPricingTable(ctx.customerId ?? undefined)
      .then((response) => {
        if (!cancelled) {
          setPlans(response.plans);
          setGroups(response.groups);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [ctx.client, ctx.customerId, ctx.loading]);

  return { plans, groups, loading, error };
}

// ── useValidateCoupon ────────────────────────────────────────────────────────

/**
 * Validate a coupon code for the current customer.
 *
 * ```tsx
 * function CouponInput({ product, amount }: { product: string; amount: number }) {
 *   const { validate, result, loading } = useValidateCoupon();
 *   const [code, setCode] = useState("");
 *
 *   return (
 *     <div>
 *       <input value={code} onChange={(e) => setCode(e.target.value)} />
 *       <button onClick={() => validate(code, product, amount)}>Apply</button>
 *       {result?.valid && <span>You save {result.discountAmount}!</span>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useValidateCoupon(): {
  validate: (code: string, product: string, amount: number) => Promise<void>;
  result: CouponValidation | null;
  loading: boolean;
} {
  const ctx = usePayContext();
  const [result, setResult] = useState<CouponValidation | null>(null);
  const [loading, setLoading] = useState(false);

  const validate = useCallback(
    async (code: string, product: string, amount: number) => {
      if (!ctx.customerId) return;
      setLoading(true);
      try {
        const validation = await ctx.client.validateCoupon({
          code,
          customer: ctx.customerId,
          product,
          amount,
        });
        setResult(validation);
      } catch (err) {
        setResult({ valid: false, message: err instanceof Error ? err.message : "Validation failed" });
      } finally {
        setLoading(false);
      }
    },
    [ctx.client, ctx.customerId],
  );

  return { validate, result, loading };
}

// ── usePortal ────────────────────────────────────────────────────────────────

/**
 * Generate a customer billing portal URL.
 *
 * ```tsx
 * function AccountPage() {
 *   const { openPortal, loading } = usePortal();
 *   return <button onClick={openPortal} disabled={loading}>Manage Billing</button>;
 * }
 * ```
 */
export function usePortal(): {
  openPortal: () => Promise<void>;
  portalUrl: string | null;
  loading: boolean;
} {
  const ctx = usePayContext();
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const openPortal = useCallback(async () => {
    if (!ctx.customerId) return;
    setLoading(true);
    try {
      const { url } = await ctx.client.portal(ctx.customerId);
      setPortalUrl(url);
      window.location.href = url;
    } finally {
      setLoading(false);
    }
  }, [ctx.client, ctx.customerId]);

  return { openPortal, portalUrl, loading };
}

export type {
  CyncoBillingContextValue,
  CyncoBillingProviderProps,
  Plan,
  CustomerEligibility,
  SubscriptionSummary,
  PricingTablePlan,
};

// ── CyncoPricingTable (rendered component) ──────────────────────────────────

/**
 * Drop-in pricing table component. Fetches plans from the API and renders
 * a responsive pricing grid with subscribe buttons.
 *
 * ```tsx
 * <CyncoBillingProvider publishableKey="cp_pk_..." customerId="user_123">
 *   <CyncoPricingTable
 *     onSubscribe={(slug) => console.log("Subscribing to", slug)}
 *     highlightPlan="pro"
 *     columns={3}
 *   />
 * </CyncoBillingProvider>
 * ```
 */
export function CyncoPricingTable({
  onSubscribe,
  highlightPlan,
  columns = 3,
  showFeatures = true,
  ctaText = "Get Started",
  currentPlanText = "Current Plan",
  className,
}: {
  /** Called when user clicks subscribe. Receives the product slug. */
  onSubscribe?: (productSlug: string, priceId?: string) => void;
  /** Slug of the plan to visually highlight (e.g. "pro"). */
  highlightPlan?: string;
  /** Number of columns in the grid (1-4). */
  columns?: 1 | 2 | 3 | 4;
  /** Whether to show feature lists under each plan. */
  showFeatures?: boolean;
  /** Text for the subscribe button. */
  ctaText?: string;
  /** Text shown on the current plan button. */
  currentPlanText?: string;
  /** Additional CSS class for the container. */
  className?: string;
}): React.ReactElement {
  const { plans, loading, error } = usePricingTable();
  const ctx = usePayContext();

  if (loading) {
    return (
      <div className={className} style={{ textAlign: "center", padding: "2rem" }}>
        <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>Loading plans...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={className} style={{ textAlign: "center", padding: "2rem" }}>
        <p style={{ color: "#ef4444", fontSize: "0.875rem" }}>Failed to load pricing.</p>
      </div>
    );
  }

  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${Math.min(columns, plans.length)}, 1fr)`,
    gap: "1.5rem",
    maxWidth: columns === 1 ? "24rem" : columns === 2 ? "48rem" : "72rem",
    margin: "0 auto",
  };

  const handleSubscribe = async (slug: string, priceId?: string) => {
    if (onSubscribe) {
      onSubscribe(slug, priceId);
      return;
    }
    // Default behavior: call subscribe via the SDK
    if (!ctx.customerId) return;
    try {
      const result = await ctx.client.subscribe({
        customer: ctx.customerId,
        product: slug,
        priceId,
        successUrl: window.location.href,
        cancelUrl: window.location.href,
      });
      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
      } else if (result.url) {
        window.location.href = result.url;
      }
    } catch (err) {
      console.error("[CyncoPricingTable] Subscribe failed:", err);
    }
  };

  return (
    <div className={className} style={gridStyle}>
      {plans.map((plan) => {
        const isHighlighted = plan.slug === highlightPlan;
        const isCurrent = plan.customerEligibility?.scenario === "active";
        const price = plan.prices[0]; // primary price

        return (
          <div
            key={plan.id}
            style={{
              border: isHighlighted ? "2px solid #111827" : "1px solid #e5e7eb",
              borderRadius: "0.75rem",
              padding: "1.5rem",
              display: "flex",
              flexDirection: "column",
              position: "relative",
              backgroundColor: "#ffffff",
            }}
          >
            {isHighlighted && (
              <div
                style={{
                  position: "absolute",
                  top: "-0.75rem",
                  left: "50%",
                  transform: "translateX(-50%)",
                  backgroundColor: "#111827",
                  color: "#ffffff",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  padding: "0.125rem 0.75rem",
                  borderRadius: "9999px",
                }}
              >
                Popular
              </div>
            )}

            <h3 style={{ fontSize: "1.125rem", fontWeight: 600, color: "#111827" }}>
              {plan.name}
            </h3>

            {price && (
              <div style={{ marginTop: "0.75rem" }}>
                <span style={{ fontSize: "2rem", fontWeight: 700, color: "#111827" }}>
                  {price.amountFormatted}
                </span>
                {price.billingInterval && (
                  <span style={{ fontSize: "0.875rem", color: "#6b7280", marginLeft: "0.25rem" }}>
                    / {price.billingInterval}
                  </span>
                )}
                {price.trialDays && price.trialDays > 0 && (
                  <p style={{ fontSize: "0.75rem", color: "#059669", marginTop: "0.25rem" }}>
                    {price.trialDays}-day free trial
                  </p>
                )}
              </div>
            )}

            {showFeatures && plan.features.length > 0 && (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "1rem 0",
                  flex: 1,
                }}
              >
                {plan.features.map((f) => (
                  <li
                    key={f.slug}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      fontSize: "0.875rem",
                      color: "#374151",
                      padding: "0.25rem 0",
                    }}
                  >
                    <span style={{ color: "#10b981", fontSize: "1rem" }}>&#10003;</span>
                    {f.unlimited
                      ? `Unlimited ${f.name}`
                      : f.allowance
                        ? `${f.allowance.toLocaleString()} ${f.name}`
                        : f.name}
                  </li>
                ))}
              </ul>
            )}

            <button
              onClick={() => !isCurrent && handleSubscribe(plan.slug, price?.id)}
              disabled={isCurrent}
              style={{
                marginTop: "auto",
                width: "100%",
                padding: "0.625rem 1rem",
                borderRadius: "0.5rem",
                border: isCurrent ? "1px solid #d1d5db" : "none",
                backgroundColor: isCurrent
                  ? "#ffffff"
                  : isHighlighted
                    ? "#111827"
                    : "#f3f4f6",
                color: isCurrent
                  ? "#9ca3af"
                  : isHighlighted
                    ? "#ffffff"
                    : "#111827",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: isCurrent ? "default" : "pointer",
                transition: "background-color 0.15s",
              }}
            >
              {isCurrent ? currentPlanText : ctaText}
            </button>
          </div>
        );
      })}
    </div>
  );
}
