# @cynco/pay

Accept payments with 3 API calls. Accounting happens automatically.

```ts
const pay = new CyncoPay({ key: "cp_sk_..." });

// Subscribe a customer
await pay.subscribe({ customer: "user_123", product: "pro", successUrl: "/thanks" });

// Check if they can use a feature
const { allowed } = await pay.check("user_123", "api_calls");

// Track usage
await pay.track("user_123", "api_calls");
```

Every payment auto-posts to the general ledger. One integration replaces Stripe + QuickBooks.

**No Stripe key needed. No CHIP key needed.** Just `cp_sk_...` — we handle the payment gateway for you.

## Install

```bash
npm install @cynco/pay
```

## Quick Start (5 minutes)

### 1. Get your API key

Create a key in your [Cynco dashboard](https://app.cynco.io) or via the API:

```bash
curl -X POST https://app.cynco.io/api/v1/pay/api-keys \
  -H "Authorization: Bearer cp_sk_..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "Production", "type": "secret" }'
```

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

if (result.url) {
  // Redirect to checkout
  redirect(result.url);
} else {
  // Activated immediately (stored card charged)
  console.log(result.subscription);
}
```

### 4. Gate features

```ts
const { allowed, balance } = await pay.check("user_123", "api_calls");

if (!allowed) {
  return new Response("Upgrade required", { status: 402 });
}

// Do the work, then track
await pay.track("user_123", "api_calls");
```

That's it. The customer is subscribed, gated, metered, and billed. GL entries posted automatically.

---

## Core Concepts

### Check + Track (two-call pattern)

```
check → allowed? → do work → track
```

`check` tells you if the customer has access. `track` records usage and decrements the balance. For high-concurrency scenarios, use the atomic one-call pattern:

```ts
// Atomic check + deduct in one call — zero race conditions
const { allowed } = await pay.check("user_123", "api_calls", { sendEvent: true });
```

### Balance Locking (for AI completions)

When you don't know the final cost upfront:

```ts
// 1. Reserve tokens
const { allowed, lockId } = await pay.check("user_123", "ai_tokens", {
  requiredBalance: 4000,
  sendEvent: true,
  lock: { enabled: true, expiresAt: Date.now() + 60_000 },
});

// 2. Do the work
const completion = await openai.chat.completions.create({ ... });

// 3. Finalize with actual usage
await pay.finalizeLock({
  lockId,
  action: "confirm",
  overrideValue: completion.usage.total_tokens,
});
```

Unused tokens are refunded automatically. Locks expire if you don't finalize.

### Subscriptions

```ts
// Subscribe (new, upgrade, or downgrade — handled automatically)
await pay.subscribe({ customer: "user_123", product: "pro", successUrl: "..." });

// Cancel at end of billing period
await pay.updateSubscription({ customer: "user_123", product: "pro", cancelAction: "cancel_end_of_cycle" });

// Uncancel
await pay.updateSubscription({ customer: "user_123", product: "pro", cancelAction: "uncancel" });

// Cancel immediately with prorated refund
await pay.updateSubscription({ customer: "user_123", product: "pro", cancelAction: "cancel_immediately" });
```

### Upgrade & Downgrade

Upgrades charge a prorated amount immediately. Downgrades are scheduled at period end.

```ts
// Preview what the customer will pay
const preview = await pay.previewAttach("user_123", "enterprise");
console.log(preview.lineItems); // [{ title: "Enterprise", amount: 5000 }, { title: "Credit for Pro", amount: -1500 }]
console.log(preview.total);     // 3500

// Execute the upgrade
await pay.subscribe({ customer: "user_123", product: "enterprise" });
```

### Carry-Over on Upgrade

```ts
// Carry unused balance from old plan
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

---

## Pricing Models

### Free Plan

```ts
await pay.createProduct({
  name: "Free",
  slug: "free",
  autoEnable: true, // auto-assigned on customer creation
  prices: [{ type: "recurring", amount: 0, billingInterval: "month" }],
  features: [
    { slug: "api_calls", name: "API Calls", type: "metered", allowanceType: "fixed", allowance: 100 },
  ],
});
```

### Usage-Based Pricing

```ts
await pay.createProduct({
  name: "Pay As You Go",
  slug: "payg",
  features: [
    {
      slug: "notifications",
      name: "Notifications",
      type: "metered",
      allowanceType: "fixed",
      allowance: 1000, // included free
      overageAllowed: true,
      overagePrice: 1, // $0.01 per notification after included
    },
  ],
});
// Overage billed automatically at end of billing period
```

### One-Off Purchase (Credit Top-Up)

```ts
await pay.subscribe({
  customer: "user_123",
  product: "credit_top_up",
  quantity: 500, // buy 500 credits
  successUrl: "...",
});
```

### Per-Seat Pricing

```ts
// Create a seat entity
await pay.createEntity({ customer: "org_123", entityId: "user_alice", featureId: "seats", name: "Alice" });

// Check entity-level balance
const { allowed } = await pay.check("org_123", "ai_messages", { entityId: "user_alice" });

// Track entity-level usage
await pay.track("org_123", "ai_messages", { entityId: "user_alice", amount: 1 });

// Remove a seat (auto-decrements count)
await pay.deleteEntity("org_123", "user_alice");
```

### Tiered Pricing

Graduated (each tier at its own rate) and volume (single rate by total) are both supported. Configure via product creation with `tiers` on the price.

---

## Customers

```ts
// Idempotent get-or-create — safe to call on every login
const customer = await pay.getOrCreateCustomer({
  customerId: "user_123",
  name: "Jane Doe",
  email: "jane@example.com",
});

// Returns: subscriptions, balances, flags, payment methods
console.log(customer.subscriptions);
console.log(customer.balances.api_calls.remaining);
console.log(customer.flags.sso); // boolean features as flags

// Update customer info
await pay.updateCustomer({ customerId: "user_123", name: "Jane Smith" });

// Grant promotional credits (standalone balance)
await pay.createBalance({ customer: "user_123", feature: "credits", grantedBalance: 500 });
```

---

## Webhooks

```ts
import { verifyWebhook } from "@cynco/pay/webhooks";

app.post("/webhooks/cynco", (req, res) => {
  const event = verifyWebhook(req.body, req.headers["x-cynco-signature"], SECRET);

  switch (event.type) {
    case "subscription.activated":
      // Provision access
      break;
    case "payment.failed":
      // Send custom notification
      break;
    case "entitlement.exhausted":
      // Upsell prompt
      break;
  }

  res.json({ received: true });
});
```

Register a webhook endpoint:

```ts
const webhook = await pay.createWebhook({
  url: "https://yourapp.com/webhooks/cynco",
  events: ["subscription.activated", "payment.failed"],
});
// Save webhook.secret — shown only once
```

---

## React

```tsx
import { CyncoPayProvider, useCyncoPay, useBalance, useSubscriptions, useEntity } from "@cynco/pay/react";

function App() {
  return (
    <CyncoPayProvider publishableKey="cp_pk_..." customerId="user_123">
      <Dashboard />
    </CyncoPayProvider>
  );
}

function Dashboard() {
  const { check, subscribe, track } = useCyncoPay();
  const { balance, granted, usage } = useBalance("api_calls");
  const { subscriptions } = useSubscriptions();

  return (
    <div>
      <p>{usage} / {granted} API calls used</p>
      <button onClick={() => subscribe("pro", { successUrl: "/thanks" })}>
        Upgrade to Pro
      </button>
    </div>
  );
}

function WorkspaceView({ entityId }: { entityId: string }) {
  const { check, track } = useEntity(entityId);
  // Entity-scoped operations
}
```

---

## Billing Portal

Generate a self-service portal URL for customers to manage subscriptions and update payment methods:

```ts
const { url } = await pay.portal("user_123");
// Redirect customer to url — signed, 1-hour TTL
```

---

## Analytics

```ts
// MRR, ARR, churn, ARPU, trial conversion
const metrics = await pay.analytics();

// Revenue timeline for charts
const timeline = await pay.revenueTimeline(12);

// Usage events over time (pass to Recharts)
const events = await pay.aggregateEvents("user_123", "api_calls", { range: "30d", groupBy: "day" });
```

---

## Coupons

```ts
// Create a coupon
const coupon = await pay.createCoupon({
  code: "SAVE20",
  type: "percentage",     // "percentage" | "fixed" | "trial_extension"
  value: 20,              // 20% off
  duration: "repeating",  // "once" | "repeating" | "forever"
  durationMonths: 3,      // applies for 3 billing cycles
  maxRedemptions: 100,
});

// Validate at checkout (safe with publishable key)
const { valid, discountAmount, finalAmount } = await pay.validateCoupon({
  code: "SAVE20",
  customer: "user_123",
  product: "pro",
  amount: 2000,
});
// → { valid: true, discountAmount: 400, finalAmount: 1600 }

// Update or archive
await pay.updateCoupon("pcpn_1", { name: "Summer Sale" });
await pay.archiveCoupon("pcpn_1");
```

---

## API Keys

```ts
// Create (raw key shown only once — store securely)
const { rawKey } = await pay.createApiKey({ name: "Production", type: "secret" });

// List (masked) and revoke
const keys = await pay.listApiKeys();
await pay.revokeApiKey("pak_1");
```

---

## Idempotency

All billing-mutating endpoints support safe retries via the `Idempotency-Key` header:

```ts
await pay.subscribe(
  { customer: "user_123", product: "pro", successUrl: "..." },
  { idempotencyKey: "checkout_abc123" },
);

await pay.cancel("user_123", { product: "pro" }, { idempotencyKey: "cancel_abc123" });
```

---

## Product Versioning

When you update a product, existing subscribers stay grandfathered on their version:

```ts
// List versions
const { versions } = await pay.listProductVersions("pprod_xxx");

// Migrate customers to latest
await pay.migrateCustomers("pprod_xxx", "pver_old_version_id");
```

---

## Error Handling

```ts
import { CyncoPayError } from "@cynco/pay";

try {
  await pay.subscribe({ ... });
} catch (err) {
  if (err instanceof CyncoPayError) {
    console.log(err.code);    // "VALIDATION_ERROR"
    console.log(err.status);  // 422
    console.log(err.details); // [{ field: "customer", message: "required" }]
  }
}
```

### Required Actions

When a payment can't be processed automatically (3DS, card declined):

```ts
const result = await pay.subscribe({ ... });

if (result.requiredAction) {
  console.log(result.requiredAction.code);   // "payment_failed" | "3ds_required"
  console.log(result.requiredAction.reason); // "Card was declined"
  // Redirect to result.url for the customer to resolve
}
```

---

## API Reference

### Core

| Method | Description |
|--------|-------------|
| `subscribe(input)` | Subscribe, upgrade, or downgrade a customer |
| `check(customer, feature, options?)` | Check feature access (with optional atomic deduct or lock) |
| `track(customer, feature, options?)` | Record usage for a metered feature |
| `cancel(customer, options?)` | Cancel a subscription |
| `finalizeLock(input)` | Confirm, release, or adjust a balance lock |

### Customers

| Method | Description |
|--------|-------------|
| `getOrCreateCustomer(input)` | Idempotent get-or-create |
| `getCustomer(id)` | Get customer with subscriptions, balances, flags |
| `updateCustomer(input)` | Update name/email |
| `deleteCustomer(id)` | Delete customer mapping |
| `listCustomers()` | List all customers |

### Products & Plans

| Method | Description |
|--------|-------------|
| `createProduct(input)` | Create product with prices and features |
| `listProducts()` | List all products |
| `listPlans(customer?)` | List plans with eligibility |
| `previewAttach(customer, product)` | Preview charge before subscribing |

### Subscriptions

| Method | Description |
|--------|-------------|
| `updateSubscription(input, options?)` | Cancel, uncancel, pause, resume, or change quantities |
| `previewUpdate(input)` | Preview subscription changes |
| `listSubscriptions(status?, params?)` | List subscriptions |

### Balances & Entities

| Method | Description |
|--------|-------------|
| `createBalance(input)` | Grant standalone credits |
| `updateBalance(input)` | Set usage or balance directly |
| `createEntity(input)` | Create entity (seat/workspace) |
| `deleteEntity(customer, entityId)` | Remove entity |
| `listEntities(customer, params?)` | List entities |

### Billing

| Method | Description |
|--------|-------------|
| `portal(customer)` | Generate billing portal URL |
| `analytics()` | MRR, ARR, churn, ARPU |
| `revenueTimeline(months?)` | Monthly revenue chart data |
| `aggregateEvents(customer, feature, options?)` | Usage timeline |
| `getPricingTable(customer?)` | Embeddable pricing table with formatted prices |

### Webhooks

| Method | Description |
|--------|-------------|
| `createWebhook(input)` | Register endpoint |
| `listWebhooks(params?)` | List endpoints |
| `deleteWebhook(id)` | Remove endpoint |

### Coupons

| Method | Description |
|--------|-------------|
| `createCoupon(input)` | Create a discount coupon |
| `listCoupons(params?)` | List all coupons |
| `getCoupon(id)` | Get coupon by ID |
| `updateCoupon(id, input)` | Update coupon properties |
| `archiveCoupon(id)` | Soft-delete a coupon |
| `validateCoupon(input)` | Validate a code for a customer + product |

### Spend Caps

| Method | Description |
|--------|-------------|
| `getSpendCap(customer, feature)` | Get spend cap status |
| `setSpendCap(input)` | Set or remove a customer spend cap |
| `setProductSpendCap(input)` | Set default cap for a product |

### API Keys

| Method | Description |
|--------|-------------|
| `createApiKey(input)` | Create a new API key (raw key shown once) |
| `listApiKeys(params?)` | List API keys (masked) |
| `revokeApiKey(id)` | Revoke an API key |

### Rewards & Referrals

| Method | Description |
|--------|-------------|
| `createRewardProgram(input)` | Create a referral/reward program |
| `listRewardPrograms()` | List all programs |
| `createReferralCode(input)` | Create a referral code for a customer |
| `listReferralCodes(customer)` | List referral codes |
| `redeemReferralCode(input)` | Redeem a referral code |

### Audit & Versioning

| Method | Description |
|--------|-------------|
| `listAuditEvents(filters?)` | List billing audit trail |
| `listProductVersions(productId)` | List version history |
| `migrateCustomers(productId, versionId)` | Migrate to latest |

---

## What Makes Cynco Pay Different

- **Accounting built in.** Every charge auto-posts to the general ledger (DR Receivable 1200, CR Revenue 4001). No reconciliation needed.
- **Balance locking.** Reserve tokens before an AI completion, finalize with actual usage. Purpose-built for AI SaaS.
- **CHIP + Stripe.** Malaysian payment gateway native. Not just a Stripe wrapper.
- **Zero infrastructure.** No Redis, no queues, no external services. Postgres advisory locks for concurrency. All-in-one.
- **Per-customer locking.** Billing operations are serialized per customer. No double-charges from race conditions.
- **API idempotency.** `Idempotency-Key` header on all billing endpoints. Safe retries.

## License

MIT
