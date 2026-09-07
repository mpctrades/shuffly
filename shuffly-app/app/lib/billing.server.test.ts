import { describe, expect, it, vi } from "vitest";
import {
  planIdFromSubscriptionName,
  confirmationUrlFromBillingRedirect,
  requestSubscriptionConfirmationUrl,
  planApprovalReturnUrl,
} from "./billing.server";

// Only planIdFromSubscriptionName is tested here — reconcilePlanFromSubscriptions
// and previewDowngradeImpact both hit the real Prisma db and belong in an
// integration test against a real (test) database instead of a unit test.
describe("planIdFromSubscriptionName", () => {
  it("maps both the monthly and annual subscription names to the same PlanId", () => {
    expect(planIdFromSubscriptionName("STARTER")).toBe("STARTER");
    expect(planIdFromSubscriptionName("STARTER_ANNUAL")).toBe("STARTER");
    expect(planIdFromSubscriptionName("PRO")).toBe("PRO");
    expect(planIdFromSubscriptionName("PRO_ANNUAL")).toBe("PRO");
    expect(planIdFromSubscriptionName("AGENCY")).toBe("AGENCY");
    expect(planIdFromSubscriptionName("AGENCY_ANNUAL")).toBe("AGENCY");
  });

  it("defaults to FREE for undefined, empty, or unrecognized names", () => {
    expect(planIdFromSubscriptionName(undefined)).toBe("FREE");
    expect(planIdFromSubscriptionName("")).toBe("FREE");
    expect(planIdFromSubscriptionName("SOME_OTHER_CHARGE")).toBe("FREE");
  });
});

// The two shapes Shopify's `billing.request` actually throws. Getting the
// confirmation URL out of them is the whole reason plan switching works at
// all from inside the embedded admin, so both are pinned here.
describe("confirmationUrlFromBillingRedirect", () => {
  const CONFIRMATION = "https://admin.shopify.com/store/demo/charges/shuffly/123/confirm";

  it("reads the App Bridge reauthorize header off the 401 a session-token fetch gets", () => {
    const thrown = new Response(undefined, {
      status: 401,
      headers: { "X-Shopify-API-Request-Failure-Reauthorize-Url": CONFIRMATION },
    });
    expect(confirmationUrlFromBillingRedirect(thrown)).toBe(CONFIRMATION);
  });

  it("reads the exitIframe param off the 302 a document request gets", () => {
    const thrown = new Response(undefined, {
      status: 302,
      headers: {
        Location: `/auth/exit-iframe?shop=demo.myshopify.com&exitIframe=${encodeURIComponent(CONFIRMATION)}`,
      },
    });
    expect(confirmationUrlFromBillingRedirect(thrown)).toBe(CONFIRMATION);
  });

  it("falls back to an absolute Location (non-embedded apps)", () => {
    const thrown = new Response(undefined, { status: 302, headers: { Location: CONFIRMATION } });
    expect(confirmationUrlFromBillingRedirect(thrown)).toBe(CONFIRMATION);
  });

  it("returns null for anything that isn't one of those redirects", () => {
    expect(confirmationUrlFromBillingRedirect(new Error("boom"))).toBeNull();
    expect(confirmationUrlFromBillingRedirect(new Response(undefined, { status: 500 }))).toBeNull();
  });
});

describe("requestSubscriptionConfirmationUrl", () => {
  const CONFIRMATION = "https://admin.shopify.com/store/demo/charges/shuffly/123/confirm";

  it("turns the thrown redirect into a returned URL", async () => {
    await expect(
      requestSubscriptionConfirmationUrl(() => {
        throw new Response(undefined, {
          status: 401,
          headers: { "X-Shopify-API-Request-Failure-Reauthorize-Url": CONFIRMATION },
        });
      }),
    ).resolves.toBe(CONFIRMATION);
  });

  it("rethrows a genuine failure instead of swallowing it as a redirect", async () => {
    await expect(
      requestSubscriptionConfirmationUrl(() => Promise.reject(new Error("Billing API down"))),
    ).rejects.toThrow("Billing API down");
  });
});

describe("planApprovalReturnUrl", () => {
  it("returns the merchant to the Plan page inside the embedded admin", () => {
    vi.stubEnv("SHOPIFY_API_KEY", "test-client-id");
    expect(planApprovalReturnUrl("demo.myshopify.com", "https://app.example.com")).toBe(
      "https://admin.shopify.com/store/demo/apps/test-client-id/app/plan",
    );
    vi.unstubAllEnvs();
  });

  it("falls back to the app origin when the API key is missing", () => {
    vi.stubEnv("SHOPIFY_API_KEY", "");
    expect(planApprovalReturnUrl("demo.myshopify.com", "https://app.example.com")).toBe(
      "https://app.example.com/app/plan",
    );
    vi.unstubAllEnvs();
  });
});
