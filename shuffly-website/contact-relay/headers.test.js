// Header composition tests. These are the assertions that matter for the
// identity bug: the From display name, the Subject prefix and — above all —
// that Reply-To is the person who filled in the form, never the sending
// mailbox. No Gmail round-trip, so this runs anywhere.
//
//   node headers.test.js

// Deliberately the decorated shape the server actually has in .env, so the
// nested-bracket bug this caused stays caught.
process.env.GMAIL_FROM_EMAIL = "StockPing <sender@mpctrades.com>";
process.env.CONTACT_TO_EMAIL = "team@mpctrades.com";

const assert = require("assert");
const { composeHeaders, siteFor, buildRawMessage, bareAddress } = require("./index.js");

const SITES = require("./sites.json");

function submission(over = {}) {
  return {
    name: "Dana Merchant",
    email: "dana@gmail.com",
    store: "dana-shop.myshopify.com",
    topic: "General question",
    message: "How many collections can rotate?",
    ...over,
  };
}

// --- The sending address ---------------------------------------------------
{
  assert.strictEqual(bareAddress("StockPing <sender@mpctrades.com>"), "sender@mpctrades.com");
  assert.strictEqual(bareAddress("sender@mpctrades.com"), "sender@mpctrades.com");
  assert.strictEqual(bareAddress('"Odd, Name" <sender@mpctrades.com>'), "sender@mpctrades.com");
  assert.strictEqual(bareAddress(undefined), "");
  console.log("ok  bare address extracted from a decorated GMAIL_FROM_EMAIL");
}

// --- Shuffly ---------------------------------------------------------------
{
  const h = composeHeaders(submission(), { ...SITES["shuffly.mpctrades.com"], host: "shuffly.mpctrades.com" });
  assert.strictEqual(h.from, '"Shuffly" <sender@mpctrades.com>');
  assert.strictEqual(h.subject, "Shuffly contact — General question — Dana Merchant");
  assert.strictEqual(h.replyTo, '"Dana Merchant" <dana@gmail.com>');
  assert.ok(h.html.includes("New message from shuffly.mpctrades.com"));
  assert.ok(!h.html.includes("StockPing"), "no StockPing branding may leak into a Shuffly email");
  assert.ok(!/<[^>]*</.test(h.from), "From must not nest brackets");
  console.log("ok  shuffly: from/subject/reply-to/body-head");
}

// --- StockPing, unchanged behaviour ---------------------------------------
{
  const h = composeHeaders(submission(), { ...SITES["stockping-web.mpctrades.com"], host: "stockping-web.mpctrades.com" });
  assert.strictEqual(h.from, '"StockPing" <sender@mpctrades.com>');
  assert.ok(h.subject.startsWith("StockPing contact — "), "existing inbox filters key off this prefix");
  assert.strictEqual(h.replyTo, '"Dana Merchant" <dana@gmail.com>');
  assert.ok(h.html.includes("New message from stockping-web.mpctrades.com"));
  assert.ok(!h.html.includes("Shuffly"), "no Shuffly branding may leak into a StockPing email");
  assert.ok(!/<[^>]*</.test(h.from), "From must not nest brackets");
  console.log("ok  stockping: from/subject/reply-to/body-head");
}

// The www alias is in nginx's server_name, so it must brand as StockPing too.
{
  const s = siteFor({ headers: { host: "www.stockping.mpctrades.com" } });
  assert.strictEqual(s.brand, "StockPing");
  assert.strictEqual(s.site, "stockping-web.mpctrades.com");
  console.log("ok  www alias brands as StockPing");
}

// --- Host resolution -------------------------------------------------------
{
  assert.strictEqual(siteFor({ headers: { host: "SHUFFLY.mpctrades.com:443" } }).brand, "Shuffly", "host match is case- and port-insensitive");
  const unknown = siteFor({ headers: { host: "somewhere-else.example" } });
  assert.strictEqual(unknown.brand, "Website", "an unconfigured host still delivers, with neutral branding");
  assert.strictEqual(siteFor({ headers: {} }).brand, "Website");
  console.log("ok  host resolution: case, port, unknown, missing");
}

// --- The topic field, old and new names ------------------------------------
{
  // Shuffly's redeployed form sends `topic`; StockPing's still sends `reason`.
  const viaReason = composeHeaders({ ...submission({ topic: undefined }), reason: "Bug report" }, { brand: "StockPing", site: "s", host: "s" });
  assert.ok(viaReason.subject.includes("Bug report"), "the older `reason` field is still honoured");
  const noTopic = composeHeaders(submission({ topic: "" }), { brand: "Shuffly", site: "s", host: "s" });
  assert.ok(noTopic.subject.includes("Get in touch"), "a missing topic falls back rather than reading blank");
  console.log("ok  topic accepts `topic` and legacy `reason`");
}

// --- Header injection ------------------------------------------------------
{
  const h = composeHeaders(
    submission({ name: 'Eve"\r\nBcc: attacker@evil.example', topic: "Ask\r\nX-Injected: yes" }),
    { brand: "Shuffly", site: "shuffly.mpctrades.com", host: "shuffly.mpctrades.com" }
  );
  assert.ok(!h.replyTo.includes("\r") && !h.replyTo.includes("\n"), "Reply-To must stay on one line");
  assert.ok(!h.replyTo.includes('"Eve"'), "a quote in the name must not close the display name early");
  const raw = Buffer.from(buildRawMessage(h), "base64url").toString("utf8");
  const headerBlock = raw.split("\r\n\r\n")[0];
  assert.ok(!/^Bcc:/im.test(headerBlock), "no injected Bcc header");
  assert.ok(!/^X-Injected:/im.test(headerBlock), "no injected arbitrary header");
  console.log("ok  CRLF and quote injection are neutralised");
}

console.log("\nall header tests passed");
