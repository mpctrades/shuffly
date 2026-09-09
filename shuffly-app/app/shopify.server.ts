import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { startInProcessSchedulerOnce } from "./lib/scheduler.server";

// Shuffly is on **Shopify managed pricing**: the plans merchants actually
// see and buy are defined in the Partner Dashboard, and Shopify refuses
// `appSubscriptionCreate` for this app ("Cannot use the Billing API (to
// create charges) when on Shopify App Pricing"). So nothing below ever
// creates a charge — it stays only to keep `billing.check()` configured and
// typed, which is how the Plan page reads the active subscription back
// (app/lib/billing.server.ts). Amounts must still match the Partner
// Dashboard plans, since the Plan page displays prices from plans.ts.
export const BILLING_PLANS = {
  STARTER: {
    replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    lineItems: [
      {
        amount: 3.99,
        currencyCode: "USD",
        interval: BillingInterval.Every30Days as const,
      },
    ],
  },
  STARTER_ANNUAL: {
    replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    lineItems: [
      {
        amount: 39.9,
        currencyCode: "USD",
        interval: BillingInterval.Annual as const,
      },
    ],
  },
  PRO: {
    replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    lineItems: [
      {
        amount: 7.99,
        currencyCode: "USD",
        interval: BillingInterval.Every30Days as const,
      },
    ],
  },
  PRO_ANNUAL: {
    replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    lineItems: [
      {
        amount: 79.9,
        currencyCode: "USD",
        interval: BillingInterval.Annual as const,
      },
    ],
  },
};

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: BILLING_PLANS,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

// Started once per server process — see app/lib/scheduler.server.ts.
startInProcessSchedulerOnce();

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
