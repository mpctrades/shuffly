import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { adminGraphql, isRateLimitError, retryDelayMs } from "./admin-graphql.server";

const QUERY = "#graphql\n query Q { shop { id } }";
const MUTATION = "#graphql\n mutation M { collectionReorderProducts { job { id } } }";

function throttled(requested = 300, available = 100, rate = 100) {
  return Object.assign(new Error("Throttled"), {
    name: "GraphqlQueryError",
    body: {
      errors: { graphQLErrors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] },
      extensions: { cost: { requestedQueryCost: requested, throttleStatus: { currentlyAvailable: available, restoreRate: rate } } },
    },
  });
}
const http429 = (retryAfter?: number) =>
  Object.assign(new Error("Shopify is throttling requests"), { name: "HttpThrottlingError", response: { retryAfter } });
const noResponse = () =>
  Object.assign(new Error("Http request error, no response available: GraphQL Client: fetch failed"), { name: "HttpRequestError" });

describe("retryDelayMs", () => {
  it("waits for the cost bucket to refill enough for this query", () => {
    // Needs 200 more points at 100/s.
    expect(retryDelayMs(throttled(300, 100, 100), QUERY, 1)).toBe(2000);
  });

  it("never waits less than 1s or more than 10s for a throttle", () => {
    expect(retryDelayMs(throttled(101, 100, 100), QUERY, 1)).toBe(1000);
    expect(retryDelayMs(throttled(5000, 0, 50), QUERY, 1)).toBe(10_000);
  });

  it("honors Retry-After on a 429", () => {
    expect(retryDelayMs(http429(3), QUERY, 1)).toBe(3000);
    expect(retryDelayMs(http429(), QUERY, 1)).toBe(2000);
  });

  it("retries a query that got no response, but never a mutation", () => {
    expect(retryDelayMs(noResponse(), QUERY, 1)).toBe(1000);
    expect(retryDelayMs(noResponse(), QUERY, 2)).toBe(2000);
    expect(retryDelayMs(noResponse(), MUTATION, 1)).toBeNull();
  });

  it("doesn't retry ordinary GraphQL errors", () => {
    const err = Object.assign(new Error("Invalid id"), {
      name: "GraphqlQueryError",
      body: { errors: { graphQLErrors: [{ message: "Invalid id" }] } },
    });
    expect(retryDelayMs(err, QUERY, 1)).toBeNull();
  });
});

describe("adminGraphql", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a throttled call and returns the eventual answer", async () => {
    vi.useFakeTimers();
    const ok = new Response("{}");
    const graphql = vi.fn().mockRejectedValueOnce(throttled()).mockResolvedValueOnce(ok);
    const pending = adminGraphql({ graphql } as unknown as AdminApiContext, QUERY);
    await vi.runAllTimersAsync();

    expect(await pending).toBe(ok);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("gives up after 4 attempts and throws the last error", async () => {
    vi.useFakeTimers();
    const graphql = vi.fn().mockRejectedValue(throttled());
    const pending = adminGraphql({ graphql } as unknown as AdminApiContext, QUERY);
    const assertion = expect(pending).rejects.toMatchObject({ name: "GraphqlQueryError" });
    await vi.runAllTimersAsync();
    await assertion;

    expect(graphql).toHaveBeenCalledTimes(4);
  });

  it("throws a non-retryable error immediately", async () => {
    const graphql = vi.fn().mockRejectedValue(noResponse());

    await expect(adminGraphql({ graphql } as unknown as AdminApiContext, MUTATION)).rejects.toThrow(/no response/);
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});

describe("isRateLimitError", () => {
  it("recognizes both throttle shapes and nothing else", () => {
    expect(isRateLimitError(throttled())).toBe(true);
    expect(isRateLimitError(http429())).toBe(true);
    expect(isRateLimitError(noResponse())).toBe(false);
  });
});
