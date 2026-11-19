import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// admin.graphql with Shopify's rate limits handled. Without this, the first
// THROTTLED response threw straight out of a shuffle — after some reorder
// chunks had already been written — and the run was simply lost.
//
// Three failures are retried:
//   - THROTTLED (a GraphQL error on a 200): the query cost bucket is empty.
//     We wait for it to refill enough for this query, from the cost numbers
//     Shopify returns alongside the error.
//   - HTTP 429: wait for Retry-After.
//   - No response at all ("fetch failed") — but only for queries. A mutation
//     that got no answer may still have been applied, so it isn't repeated.

type GraphqlOptions = Parameters<AdminApiContext["graphql"]>[1];

const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 10_000;

interface ThrottleStatus {
  currentlyAvailable?: number;
  restoreRate?: number;
}

interface ShopifyClientError {
  name?: string;
  message?: string;
  response?: { retryAfter?: number };
  body?: {
    errors?: { graphQLErrors?: Array<{ extensions?: { code?: string } }> };
    extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: ThrottleStatus } };
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isMutation(query: string): boolean {
  return /^\s*(#graphql\s*)?mutation\b/.test(query);
}

/** How long to wait before retrying `err`, or null when it shouldn't be. */
export function retryDelayMs(err: unknown, query: string, attempt: number): number | null {
  const e = err as ShopifyClientError;

  const throttled = e?.body?.errors?.graphQLErrors?.some((g) => g.extensions?.code === "THROTTLED");
  if (throttled) {
    const cost = e.body?.extensions?.cost;
    const needed = (cost?.requestedQueryCost ?? 0) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
    const rate = cost?.throttleStatus?.restoreRate ?? 0;
    const refillMs = needed > 0 && rate > 0 ? Math.ceil((needed / rate) * 1000) : 1000;
    return Math.min(MAX_WAIT_MS, Math.max(1000, refillMs));
  }

  if (e?.name === "HttpThrottlingError") {
    const retryAfterS = e.response?.retryAfter;
    return Math.min(MAX_WAIT_MS, retryAfterS ? retryAfterS * 1000 : 2000);
  }

  if (e?.name === "HttpRequestError" && /no response available/.test(e.message ?? "") && !isMutation(query)) {
    return Math.min(MAX_WAIT_MS, 500 * 2 ** attempt);
  }

  return null;
}

/** Drop-in for `admin.graphql(query, options)`, retried as described above. */
export async function adminGraphql(
  admin: AdminApiContext,
  query: string,
  options?: GraphqlOptions,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await admin.graphql(query, options);
    } catch (err) {
      const delay = attempt < MAX_ATTEMPTS ? retryDelayMs(err, query, attempt) : null;
      if (delay == null) throw err;
      // Jitter so several collections throttled together don't retry in step.
      await sleep(delay + Math.floor(Math.random() * 250));
    }
  }
}

/** True when `err` is Shopify telling us to slow down — for messages a
 * merchant reads, which should say "busy, try again" rather than a stack. */
export function isRateLimitError(err: unknown): boolean {
  const e = err as ShopifyClientError;
  return (
    e?.name === "HttpThrottlingError" ||
    e?.name === "HttpMaxRetriesError" ||
    Boolean(e?.body?.errors?.graphQLErrors?.some((g) => g.extensions?.code === "THROTTLED"))
  );
}
