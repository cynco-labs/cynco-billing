import { describe, it, expect } from "vitest";
import { verifyWebhook, signWebhookPayload, WebhookVerificationError } from "../webhooks.js";

const SECRET = "whsec_test_secret_key_12345";

function makeEvent(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    id: "evt_test_123",
    type: "subscription.activated",
    created: "2026-03-17T00:00:00Z",
    data: { subscriptionId: "psub_abc" },
    ...overrides,
  });
}

describe("verifyWebhook", () => {
  it("verifies valid signature and returns parsed event", () => {
    const body = makeEvent();
    const signature = signWebhookPayload(body, SECRET);

    const event = verifyWebhook(body, signature, SECRET);

    expect(event.id).toBe("evt_test_123");
    expect(event.type).toBe("subscription.activated");
    expect(event.data.subscriptionId).toBe("psub_abc");
  });

  it("accepts Buffer body", () => {
    const body = makeEvent();
    const signature = signWebhookPayload(body, SECRET);

    const event = verifyWebhook(Buffer.from(body), signature, SECRET);
    expect(event.type).toBe("subscription.activated");
  });

  it("throws on missing signature", () => {
    expect(() => verifyWebhook(makeEvent(), null, SECRET)).toThrow(
      WebhookVerificationError,
    );
    expect(() => verifyWebhook(makeEvent(), undefined, SECRET)).toThrow(
      "Missing X-Cynco-Signature",
    );
  });

  it("throws on invalid signature", () => {
    expect(() => verifyWebhook(makeEvent(), "bad_sig", SECRET)).toThrow(
      WebhookVerificationError,
    );
  });

  it("throws on tampered body", () => {
    const original = makeEvent();
    const signature = signWebhookPayload(original, SECRET);
    const tampered = makeEvent({ data: { hacked: true } });

    expect(() => verifyWebhook(tampered, signature, SECRET)).toThrow(
      "Invalid webhook signature",
    );
  });

  it("throws on wrong secret", () => {
    const body = makeEvent();
    const signature = signWebhookPayload(body, SECRET);

    expect(() => verifyWebhook(body, signature, "wrong_secret")).toThrow(
      WebhookVerificationError,
    );
  });

  it("throws on missing event type", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const signature = signWebhookPayload(body, SECRET);

    expect(() => verifyWebhook(body, signature, SECRET)).toThrow(
      "missing type or id",
    );
  });

  it("throws on missing event id", () => {
    const body = JSON.stringify({ type: "test" });
    const signature = signWebhookPayload(body, SECRET);

    expect(() => verifyWebhook(body, signature, SECRET)).toThrow(
      "missing type or id",
    );
  });
});

describe("signWebhookPayload", () => {
  it("produces consistent signatures", () => {
    const body = makeEvent();
    const sig1 = signWebhookPayload(body, SECRET);
    const sig2 = signWebhookPayload(body, SECRET);
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different bodies", () => {
    const sig1 = signWebhookPayload(makeEvent(), SECRET);
    const sig2 = signWebhookPayload(makeEvent({ type: "payment.succeeded" }), SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different secrets", () => {
    const body = makeEvent();
    const sig1 = signWebhookPayload(body, SECRET);
    const sig2 = signWebhookPayload(body, "other_secret");
    expect(sig1).not.toBe(sig2);
  });
});
