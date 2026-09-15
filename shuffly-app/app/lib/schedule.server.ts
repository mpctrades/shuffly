// Re-export shim for the scheduling maths, which lives in schedule-core.ts.
//
// None of it ever touched the database or the Admin API — it is pure
// Intl-based timezone arithmetic — but it sat in a `.server.ts` file, which
// React Router refuses to let client-rendered code import. The collection
// Workspace needs `nextRunFor` in the browser, to show the merchant the
// consequence of a time change before they save it, so the maths moved to a
// client-safe module (same reasoning as plans.ts and time-slots.ts).
//
// This shim exists so the loaders, actions and webhooks that already import
// from "./schedule.server" keep working. Client components must import from
// "./schedule-core" directly — the server-only check is on the filename, not
// on what the module actually does.
export * from "./schedule-core";
