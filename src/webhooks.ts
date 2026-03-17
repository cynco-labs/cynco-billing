import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEvent, WebhookEventType } from "./types.js";

/**
 * Verify and parse a Cynco Pay webhook.
 *
 * ```ts
 * import { verifyWebhook } from "@cynco/pay/webhooks";
 *
 * app.post("/webhooks/cynco", (req, res) => {
 *   const event = verifyWebhook(req.body, req.headers["x-cynco-signature"], secret);
 *
 *   switch (event.type) {
 *     case "subscription.activated":
 *       enableProFeatures(event.data.customer);
 *       break;
 *   }
 *
 *   res.sendStatus(200);
 * });
 * ```
 */
export function verifyWebhook(
  rawBody: string | Buffer,
  signature: string | null | undefined,
  secret: string,
): WebhookEvent {
  if (!signature) {
    throw new WebhookVerificationError("Missing X-Cynco-Signature header");
  }

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf-8");
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const sigBuf = Buffer.from(signature, "hex");

  if (expectedBuf.length !== sigBuf.length || !timingSafeEqual(expectedBuf, sigBuf)) {
    throw new WebhookVerificationError("Invalid webhook signature");
  }

  const event = JSON.parse(body) as WebhookEvent;
  if (!event.type || !event.id) {
    throw new WebhookVerificationError("Invalid webhook payload — missing type or id");
  }

  return event;
}

/**
 * Compute a webhook signature for testing.
 */
export function signWebhookPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export type { WebhookEvent, WebhookEventType };
