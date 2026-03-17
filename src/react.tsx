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
import { CyncoPay, CyncoPayError } from "./client.js";
import type {
  CheckResult,
  SubscribeResult,
  TrackResult,
  SubscribeInput,
} from "./types.js";

// ── Context ──────────────────────────────────────────────────────────────────

interface CyncoPayContextValue {
  client: CyncoPay;
  customerId: string | null;
  loading: boolean;
  error: CyncoPayError | null;
  entitlements: Map<string, CheckResult>;

  /** Subscribe the current customer to a product. */
  subscribe: (
    product: string,
    options?: { successUrl?: string; cancelUrl?: string; quantity?: number },
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

const CyncoPayContext = createContext<CyncoPayContextValue | null>(null);

function usePayContext(): CyncoPayContextValue {
  const ctx = useContext(CyncoPayContext);
  if (!ctx) throw new Error("Cynco Pay hooks must be used within <CyncoPayProvider>");
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────────────

interface CyncoPayProviderProps {
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

export function CyncoPayProvider({
  publishableKey,
  baseUrl,
  customerId: customerIdProp,
  prefetch,
  children,
}: CyncoPayProviderProps) {
  const client = useMemo(
    () => new CyncoPay({ key: publishableKey, baseUrl }),
    [publishableKey, baseUrl],
  );

  const [customerId, setCustomerId] = useState<string | null>(
    typeof customerIdProp === "string" ? customerIdProp : null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CyncoPayError | null>(null);
  const [entitlements, setEntitlements] = useState<Map<string, CheckResult>>(
    new Map(),
  );
  const pendingChecks = useRef(new Set<string>());

  // Stabilize prefetch array to avoid re-fetching on every render
  const prefetchKey = prefetch ? JSON.stringify(prefetch) : "";

  // Resolve customer ID
  useEffect(() => {
    if (typeof customerIdProp === "string") {
      setCustomerId(customerIdProp);
      setLoading(false);
      return;
    }
    let cancelled = false;
    Promise.resolve(customerIdProp()).then((id) => {
      if (!cancelled) {
        setCustomerId(id);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [customerIdProp]);

  // Prefetch entitlements
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
        setEntitlements(new Map(results));
      })
      .catch((err) => {
        if (!cancelled && err instanceof CyncoPayError) setError(err);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, customerId, prefetchKey]);

  const subscribe = useCallback(
    async (
      product: string,
      options?: { successUrl?: string; cancelUrl?: string; quantity?: number },
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
      const cached = entitlements.get(feature);
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
    [client, customerId, entitlements],
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
    setEntitlements((prev) => {
      const features = Array.from(prev.keys());
      if (features.length === 0) return prev;
      // Kick off async refresh, update state when done
      Promise.all(
        features.map(async (feature) => {
          const result = await client.check(customerId, feature);
          return [feature, result] as const;
        }),
      )
        .then((results) => setEntitlements(new Map(results)))
        .catch(() => {}); // non-fatal
      return prev; // return unchanged synchronously
    });
  }, [client, customerId]);

  const value = useMemo<CyncoPayContextValue>(
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
    <CyncoPayContext.Provider value={value}>
      {children}
    </CyncoPayContext.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Access Cynco Pay from any component.
 *
 * ```tsx
 * function PricingPage() {
 *   const { subscribe, check } = useCyncoPay();
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
export function useCyncoPay(): CyncoPayContextValue {
  return usePayContext();
}

// ── useListPlans ─────────────────────────────────────────────────────────────

interface Plan {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isAddOn: boolean;
  sortOrder: number;
  prices: { id: string; amount: number; currency: string; billingInterval: string | null }[];
  features: { slug: string; name: string; allowanceType: string; allowance: number | null }[];
  customerEligibility: {
    scenario: string;
    currentSubscriptionId: string | null;
    prorationAmount: number | null;
    trialAvailable: boolean;
  } | null;
}

/**
 * List plans with customer eligibility context.
 * Automatically includes the current customer's context from CyncoPayProvider.
 *
 * ```tsx
 * function PricingPage() {
 *   const { data: plans } = useListPlans();
 *   const { subscribe } = useCyncoPay();
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
          setData(plans as Plan[]);
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
  timeline: { period: string; count: number; total: number }[] | null;
  total: { count: number; sum: number } | null;
  loading: boolean;
} {
  const ctx = usePayContext();

  const [timeline, setTimeline] = useState<{ period: string; count: number; total: number }[] | null>(null);
  const [total, setTotal] = useState<{ count: number; sum: number } | null>(null);
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

interface SubscriptionInfo {
  id: string;
  status: string;
  productSlug: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  quantity: number;
}

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
  subscriptions: SubscriptionInfo[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const ctx = usePayContext();

  const [subscriptions, setSubscriptions] = useState<SubscriptionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(0);

  const fetchSubscriptions = useCallback(async () => {
    if (!ctx.customerId) return;
    const id = ++fetchRef.current;
    setLoading(true);

    try {
      const customer = await ctx.client.getCustomer(ctx.customerId);
      if (fetchRef.current !== id) return;

      const subs = (customer as Record<string, unknown>).subscriptions;
      if (Array.isArray(subs)) {
        setSubscriptions(subs as SubscriptionInfo[]);
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
    ctx.check(featureId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId]); // intentionally omit ctx.check to avoid re-render loop

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

export type { CyncoPayContextValue, CyncoPayProviderProps, Plan, SubscriptionInfo };
