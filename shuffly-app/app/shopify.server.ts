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

// Billing plan names double as the values stored in ShopSettings.plan (the
// *_ANNUAL variants still resolve back to the same plan — see
// app/lib/billing.server.ts). The Free tier isn't listed here — it's just
// "no active subscription".
// Keep amounts in sync with app/lib/plans.server.ts — annual = 10x the
// monthly amount ("2 months free"), via plans.server.ts's annualPrice().
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
  AGENCY: {
    replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    lineItems: [
      {
        amount: 49,
        currencyCode: "USD",
        interval: BillingInterval.Every30Days as const,
      },
    ],
  },
  AGENCY_ANNUAL: {
    replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    lineItems: [
      {
        amount: 490,
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
