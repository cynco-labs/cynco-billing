<div align="center">

# @cynco/pay

**Billing for developers who'd rather ship product.**

Subscribe customers, gate features, meter usage -- in 3 API calls.<br>
Every charge auto-posts to the general ledger.

[![npm](https://img.shields.io/npm/v/@cynco/pay)](https://www.npmjs.com/package/@cynco/pay)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/@cynco/pay)](https://bundlephobia.com/package/@cynco/pay)

[Documentation](https://docs.cynco.io/pay) · [Dashboard](https://app.cynco.io) · [Discord](https://discord.gg/cynco)

</div>

---

```ts
const pay = new CyncoPay({ key: "cp_sk_..." });

await pay.subscribe({ customer: "user_123", product: "pro", successUrl: "/thanks" });
const { allowed } = await pay.check("user_123", "api_calls");
await pay.track("user_123", "api_calls");
```

---

## Why Cynco Pay

One SDK replaces your payment gateway, entitlement engine, and accounting integration. Every subscription, charge, and refund auto-posts to the general ledger with correct double-entry journal entries. No reconciliation spreadsheets. No Stripe key needed, no CHIP key needed -- just `cp_sk_...`.

| | Cynco Pay | Stripe + QuickBooks |
|---|---|---|
| Subscribe a customer | 1 call | Stripe checkout + webhook + QBO invoice |
| Gate a feature | 1 call | Custom entitlement table + cache layer |
| Track usage | 1 call | Stripe metering API + QBO sync job |
| GL journal entries | Automatic | Manual or 3rd-party sync |
| Balance locking (AI) | Built-in | Build it yourself |
| Malaysian payments | Native (CHIP) | Not supported |

---

## Install

```bash
npm install @cynco/pay
```

```bash
yarn add @cynco/pay
```

```bash
pnpm add @cynco/pay
```

```bash
bun add @cynco/pay
```

---

## Quick Start

### 1. Get your API key

Create a key in your [Cynco dashboard](https://app.cynco.io) under Settings > API Keys.

### 2. Create a product

```ts
import { CyncoPay } from "@cynco/pay";

const pay = new CyncoPay({ key: process.env.CYNCO_PAY_SECRET_KEY });

await pay.createProduct({
  name: "Pro",
  slug: "pro",
  prices: [{ type: "recurring", amount: 2000, billingInterval: "month" }],
  features: [
    { slug: "api_calls", name: "API Calls", type: "metered", allowanceType: "fixed", allowance: 10000 },
    { slug: "sso", name: "SSO", type: "boolean" },
  ],
});
```

### 3. Subscribe a customer

```ts
const result = await pay.subscribe({
  customer: { id: "user_123", email: "jane@example.com", name: "Jane" },
  product: "pro",
  successUrl: "https://yourapp.com/billing?success=true",
  cancelUrl: "https://yourapp.com/billing",
});

if (result.url) redirect(result.url);       // redirect to checkout
else console.log(result.subscription);       // activated immediately
```

### 4. Gate features

```ts
const { allowed } = await pay.check("user_123", "api_calls");

if (!allowed) return new Response("Upgrade required", { status: 402 });

await pay.track("user_123", "api_calls");
```

That's it. Subscribed, gated, metered, billed. GL entries posted automatically.

---

## Patterns

### Feature Gating

```ts
// Boolean feature -- returns allowed: true/false
const { allowed } = await pay.check("user_123", "sso");

// Metered feature -- check balance before work
const { allowed, balance } = await pay.check("user_123", "api_calls");
```

### Usage Metering

```ts
// Two-call pattern: check, then track
const { allowed } = await pay.check("user_123", "api_calls");
if (allowed) {
  doWork();
  await pay.track("user_123", "api_calls");
}

// Atomic one-call pattern: check + deduct in one roundtrip, zero race conditions
const { allowed } = await pay.check("user_123", "api_calls", { sendEvent: true });
```

### Balance Locking (for AI)

Reserve tokens before a completion, finalize with actual usage. Purpose-built for LLM applications where cost is unknown upfront.

```ts
// 1. Reserve tokens
const { allowed, lockId } = await pay.check("user_123", "ai_tokens", {
  requiredBalance: 4000,
  sendEvent: true,
  lock: { enabled: true, expiresAt: Date.now() + 60_000 },
});

if (!allowed) return new Response("Insufficient tokens", { status: 402 });

// 2. Do the work
const completion = await openai.chat.completions.create({ /* ... */ });

// 3. Finalize with actual usage (unused tokens refunded automatically)
await pay.finalizeLock({
  lockId,
  action: "confirm",
  overrideValue: completion.usage.total_tokens,
});
```

### Per-Seat Billing

```ts
// Add a seat
await pay.createEntity({ customer: "org_123", entityId: "user_alice", featureId: "seats", name: "Alice" });

// Check + track at the entity level
const { allowed } = await pay.check("org_123", "ai_messages", { entityId: "user_alice" });
await pay.track("org_123", "ai_messages", { entityId: "user_alice", amount: 1 });

// Remove a seat (auto-decrements count)
await pay.deleteEntity("org_123", "user_alice");
```

### Free Plan with Auto-Assign

```ts
await pay.createProduct({
  name: "Free",
  slug: "free",
  autoEnable: true,  // auto-assigned when customer is created
  prices: [{ type: "recurring", amount: 0, billingInterval: "month" }],
  features: [
    { slug: "api_calls", name: "API Calls", type: "metered", allowanceType: "fixed", allowance: 100 },
  ],
});
```

### Overage Billing

```ts
await pay.createProduct({
  name: "Pay As You Go",
  slug: "payg",
  features: [{
    slug: "notifications",
    name: "Notifications",
    type: "metered",
    allowanceType: "fixed",
    allowance: 1000,       // included free
    overageAllowed: true,
    overagePrice: 1,       // $0.01 per unit after allowance
  }],
});
// Overage billed automatically at end of billing period
```

### Upgrade / Downgrade

Upgrades charge a prorated amount immediately. Downgrades are scheduled at period end.

```ts
// Preview the charge before committing
const preview = await pay.previewAttach("user_123", "enterprise");
console.log(preview.lineItems);  // [{ title: "Enterprise", amount: 5000 }, { title: "Credit for Pro", amount: -1500 }]
console.log(preview.total);      // 3500

// Execute
await pay.subscribe({ customer: "user_123", product: "enterprise" });
```

### Carry-Over on Upgrade

```ts
// Carry unused balance from old plan to new plan
await pay.subscribe({
  customer: "user_123",
  product: "enterprise",
  carryOverBalances: { enabled: true },
});

// Or carry usage (deduct prior usage from new allowance)
await pay.subscribe({
  customer: "user_123",
  product: "enterprise",
  carryOverUsages: { enabled: true, featureIds: ["credits"] },
});
```

### One-Off Purchase

```ts
await pay.subscribe({
  customer: "user_123",
  product: "credit_top_up",
  quantity: 500,
  successUrl: "...",
});
```

### Cancel / Uncancel

```ts
// Cancel at end of billing period
await pay.updateSubscription({ customer: "user_123", product: "pro", cancelAction: "cancel_end_of_cycle" });

// Cancel immediately with prorated refund
await pay.updateSubscription({ customer: "user_123", product: "pro", cancelAction: "cancel_immediately" });

// Uncancel
await pay.updateSubscription({ customer: "user_123", product: "pro", cancelAction: "uncancel" });

// Or use the shorthand
await pay.cancel("user_123");
await pay.cancel("user_123", { immediate: true, reason: "Customer request" });
```

---

## React

Three entry points: `@cynco/pay`, `@cynco/pay/react`, `@cynco/pay/webhooks`. React is an optional peer dependency.

### Provider

Wrap your app once. All hooks read from this context.

```tsx
import { CyncoPayProvider } from "@cynco/pay/react";

function App() {
  return (
    <CyncoPayProvider
      publishableKey="cp_pk_..."
      customerId="user_123"
      prefetch={["api_calls", "sso"]}
    >
      <Dashboard />
    </CyncoPayProvider>
  );
}
```

`customerId` accepts a string or an async resolver:

```tsx
<CyncoPayProvider
  publishableKey="cp_pk_..."
  customerId={async () => {
    const session = await getSession();
    return session.userId;
  }}
>
```

### useCyncoPay

Core hook. Returns `subscribe`, `check`, `track`, and `refresh`.

```tsx
import { useCyncoPay } from "@cynco/pay/react";

function UpgradeButton() {
  const { subscribe, check } = useCyncoPay();
  const isPro = check("premium").allowed;

  return (
    <button
      disabled={isPro}
      onClick={() => subscribe("pro", { successUrl: "/welcome" })}
    >
      {isPro ? "Current Plan" : "Upgrade to Pro"}
    </button>
  );
}
```

### useBalance

Reads cached entitlements for a specific feature.

```tsx
import { useBalance } from "@cynco/pay/react";

function UsageBar() {
  const { balance, granted, unlimited, loading } = useBalance("api_calls");

  if (loading) return <Skeleton />;
  if (unlimited) return <span>Unlimited</span>;

  return <ProgressBar value={balance ?? 0} max={granted ?? 0} />;
}
```

### useSubscriptions

```tsx
import { useSubscriptions } from "@cynco/pay/react";

function AccountPage() {
  const { subscriptions, loading, refresh } = useSubscriptions();

  if (loading) return <Spinner />;

  return subscriptions.map((s) => (
    <div key={s.id}>{s.productSlug} -- {s.status}</div>
  ));
}
```

### useListPlans

Lists plans with customer eligibility context (new, upgrade, downgrade, active).

```tsx
import { useListPlans, useCyncoPay } from "@cynco/pay/react";

function PricingPage() {
  const { data: plans, loading } = useListPlans();
  const { subscribe } = useCyncoPay();

  if (loading) return <Spinner />;

  return plans?.map((plan) => (
    <div key={plan.id}>
      <h3>{plan.name}</h3>
      <p>{plan.prices[0]?.amount / 100}/mo</p>
      <button
        disabled={plan.customerEligibility?.scenario === "active"}
        onClick={() => subscribe(plan.slug)}
      >
        {plan.customerEligibility?.scenario === "active" ? "Current" : "Select"}
      </button>
    </div>
  ));
}
```

### useAggregateEvents

Usage timeline data for charts. Pass directly to Recharts, Chart.js, etc.

```tsx
import { useAggregateEvents } from "@cynco/pay/react";

function UsageChart() {
  const { timeline, total, loading } = useAggregateEvents({
    feature: "api_calls",
    range: "30d",
    groupBy: "day",
  });

  if (loading) return <Skeleton />;

  return <LineChart data={timeline} />;
}
```

### useEntity

Entity-scoped check and track for per-seat or per-workspace billing.

```tsx
import { useEntity } from "@cynco/pay/react";

function WorkspaceGuard({ workspaceId, children }) {
  const { check } = useEntity(workspaceId);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    check("workspace_access").then((r) => setAllowed(r.allowed));
  }, [check]);

  return allowed ? children : <UpgradePrompt />;
}
```

---

## Webhooks

```ts
import { verifyWebhook } from "@cynco/pay/webhooks";
```

Register an endpoint, then verify incoming events with HMAC-SHA256 signature validation.

```ts
// Register (save the secret -- shown only once)
const webhook = await pay.createWebhook({
  url: "https://yourapp.com/webhooks/cynco",
  events: ["subscription.activated", "payment.failed", "entitlement.exhausted"],
});
```

### Express

```ts
app.post("/webhooks/cynco", express.raw({ type: "application/json" }), (req, res) => {
  const event = verifyWebhook(req.body, req.headers["x-cynco-signature"], WEBHOOK_SECRET);

  switch (event.type) {
    case "subscription.activated":
      enableAccess(event.data.customerId);
      break;
    case "payment.failed":
      notifyCustomer(event.data.customerId);
      break;
    case "entitlement.exhausted":
      sendUpsellEmail(event.data.customerId);
      break;
  }

  res.json({ received: true });
});
```

### Next.js (App Router)

```ts
// app/api/webhooks/cynco/route.ts
import { verifyWebhook } from "@cynco/pay/webhooks";

export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get("x-cynco-signature");
  const event = verifyWebhook(body, signature, process.env.CYNCO_WEBHOOK_SECRET!);

  // handle event.type ...

  return Response.json({ received: true });
}
```

### Remix

```ts
// app/routes/webhooks.cynco.tsx
import { verifyWebhook } from "@cynco/pay/webhooks";
import type { ActionFunctionArgs } from "@remix-run/node";

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const signature = request.headers.get("x-cynco-signature");
  const event = verifyWebhook(body, signature, process.env.CYNCO_WEBHOOK_SECRET!);

  // handle event.type ...

  return Response.json({ received: true });
}
```

<details>
<summary>All webhook event types</summary>

| Event | Fired when |
|---|---|
| `subscription.created` | Subscription record created |
| `subscription.activated` | First payment succeeds or trial starts |
| `subscription.renewed` | Recurring payment succeeds |
| `subscription.upgraded` | Customer moved to a higher plan |
| `subscription.downgraded` | Customer moved to a lower plan |
| `subscription.canceled` | Subscription canceled |
| `subscription.expired` | Subscription reached end of term |
| `subscription.paused` | Subscription paused |
| `subscription.resumed` | Subscription resumed from pause |
| `payment.succeeded` | Payment collected successfully |
| `payment.failed` | Payment attempt failed |
| `payment.refunded` | Payment refunded (full or partial) |
| `invoice.created` | Invoice generated |
| `invoice.paid` | Invoice marked paid |
| `entitlement.exhausted` | Metered feature balance reached zero |

</details>

---

## Customers

```ts
// Idempotent get-or-create -- safe to call on every login
const customer = await pay.getOrCreateCustomer({
  customerId: "user_123",
  name: "Jane Doe",
  email: "jane@example.com",
});

// Returns subscriptions, balances, flags, payment methods
customer.subscriptions;
customer.balances.api_calls.remaining;
customer.flags.sso;
```

```ts
// Read
const customer = await pay.getCustomer("user_123");

// Update
await pay.updateCustomer({ customerId: "user_123", name: "Jane Smith" });

// Delete
await pay.deleteCustomer("user_123");

// List all
const customers = await pay.listCustomers();
```

### Standalone Balances

Grant promotional credits or rewards outside of a subscription.

```ts
await pay.createBalance({
  customer: "user_123",
  feature: "credits",
  grantedBalance: 500,
  resetInterval: "one_off",  // "month" | "year" | "one_off"
});

// Manually set usage or balance
await pay.updateBalance({ customer: "user_123", feature: "credits", balance: 250 });
```

---

## Billing Portal

Generate a self-service portal URL. Customers manage subscriptions, update payment methods, and view invoices.

```ts
const { url } = await pay.portal("user_123");
// Redirect -- signed URL, 1-hour TTL
```

---

## Analytics

```ts
// MRR, ARR, churn rate, ARPU, trial conversion
const metrics = await pay.analytics();

// Monthly revenue timeline for charts
const timeline = await pay.revenueTimeline(12);

// Per-customer usage aggregation
const events = await pay.aggregateEvents("user_123", "api_calls", {
  range: "30d",   // "7d" | "14d" | "30d" | "90d" | "365d"
  groupBy: "day", // "day" | "week" | "month"
});

// events.timeline -> [{ period: "2026-03-01", count: 142, total: 142 }, ...]
// events.total    -> { count: 4260, sum: 4260 }
```

---

## Product Versioning

When you update a product, existing subscribers stay grandfathered on their version.

```ts
// List versions
const { versions } = await pay.listProductVersions("pprod_xxx");

// Migrate customers from an old version to the latest
await pay.migrateCustomers("pprod_xxx", "pver_old_version_id");
```

---

## Error Handling

Every error is a typed `CyncoPayError` with machine-readable `code`, HTTP `status`, and optional field-level `details`.

```ts
import { CyncoPayError } from "@cynco/pay";

try {
  await pay.subscribe({ customer: "user_123", product: "pro", successUrl: "..." });
} catch (err) {
  if (err instanceof CyncoPayError) {
    err.code;    // "VALIDATION_ERROR" | "NOT_FOUND" | "RATE_LIMITED" | ...
    err.status;  // 422
    err.details; // [{ field: "customer", message: "required" }]
  }
}
```

### Required Actions

When a payment requires additional steps (3D Secure, card declined):

```ts
const result = await pay.subscribe({ /* ... */ });

if (result.requiredAction) {
  // result.requiredAction.code   -> "payment_failed" | "3ds_required"
  // result.requiredAction.reason -> "Card was declined"
  // Redirect to result.url for the customer to resolve
  redirect(result.url);
}
```

---

## API Reference

### Core

| Method | Description |
|---|---|
| `subscribe(input)` | Subscribe, upgrade, or downgrade a customer |
| `check(customer, feature, options?)` | Check feature access. `sendEvent: true` for atomic deduct. `lock` for balance reservation. |
| `track(customer, feature, options?)` | Record usage for a metered feature |
| `cancel(customer, options?)` | Cancel a subscription (`immediate`, `reason`) |
| `finalizeLock({ lockId, action, overrideValue? })` | Confirm, release, or adjust a balance lock |

### Customers

| Method | Description |
|---|---|
| `getOrCreateCustomer({ customerId, name?, email? })` | Idempotent get-or-create |
| `getCustomer(id)` | Get customer with subscriptions, balances, flags |
| `updateCustomer({ customerId, name?, email? })` | Update customer info |
| `deleteCustomer(id)` | Delete customer mapping |
| `listCustomers()` | List all customers |

### Products and Plans

| Method | Description |
|---|---|
| `createProduct(input)` | Create product with prices and features |
| `listProducts()` | List all products |
| `listPlans(customer?)` | List plans with customer eligibility context |
| `previewAttach(customer, product, priceId?)` | Preview charge before subscribing |

### Subscriptions

| Method | Description |
|---|---|
| `updateSubscription(input)` | Cancel, uncancel, or change feature quantities |
| `previewUpdate(input)` | Preview what a subscription update would charge |
| `listSubscriptions(status?)` | List subscriptions, optionally filtered by status |

### Balances and Entities

| Method | Description |
|---|---|
| `createBalance(input)` | Grant standalone credits |
| `updateBalance(input)` | Set usage or balance directly |
| `createEntity(input)` | Create entity (seat, workspace) under a customer |
| `deleteEntity(customer, entityId)` | Remove entity (auto-decrements seat count) |
| `listEntities(customer)` | List entities for a customer |

### Billing and Analytics

| Method | Description |
|---|---|
| `portal(customer)` | Generate self-service billing portal URL (1-hour TTL) |
| `analytics()` | MRR, ARR, churn, ARPU, trial conversion |
| `revenueTimeline(months?)` | Monthly revenue chart data |
| `aggregateEvents(customer, feature, options?)` | Usage timeline with grouping |

### Webhooks

| Method | Description |
|---|---|
| `createWebhook({ url, events? })` | Register endpoint (returns signing secret once) |
| `listWebhooks()` | List endpoints (secrets redacted) |
| `deleteWebhook(id)` | Remove endpoint |
| `verifyWebhook(body, signature, secret)` | Verify and parse incoming webhook (from `@cynco/pay/webhooks`) |

### Product Versioning

| Method | Description |
|---|---|
| `listProductVersions(productId)` | List version history (grandfathering) |
| `migrateCustomers(productId, versionId)` | Migrate subscribers to latest version |

---

## Architecture

```
Your App
  |
  |  @cynco/pay (this SDK)
  |
  v
Cynco Pay API
  |
  |--- Entitlement Engine    check / track / lock
  |--- Subscription Engine   subscribe / cancel / upgrade
  |--- Payment Gateway       CHIP (Malaysia) + Stripe
  |--- General Ledger        DR 1200 Receivable / CR 4001 Revenue
  |
  v
Cynco Dashboard              analytics, customer management, webhook logs
```

**What this means for you:**

- **No Stripe/CHIP keys.** We handle the payment gateway. You get one key: `cp_sk_...`.
- **No accounting sync.** Every charge creates journal entries automatically. DR Receivable, CR Revenue. Refunds reverse them.
- **No Redis.** Postgres advisory locks handle concurrency. Balance locking is built into the database layer.
- **No race conditions.** Per-customer locking serializes all billing operations. Atomic check+deduct prevents double-spending.
- **Idempotent by default.** `Idempotency-Key` header on all billing endpoints. Safe to retry.

---

## Configuration

```ts
const pay = new CyncoPay({
  key: "cp_sk_...",           // required -- secret key (server) or publishable key (client)
  baseUrl: "https://...",     // optional -- defaults to https://app.cynco.io
  timeout: 10_000,            // optional -- request timeout in ms, defaults to 10000
});
```

| Key prefix | Use | Permissions |
|---|---|---|
| `cp_sk_...` | Server-side | Full access (subscribe, cancel, track, manage products) |
| `cp_pk_...` | Client-side (React) | Read-only (check, list plans, view balance) |

---

## License

MIT
