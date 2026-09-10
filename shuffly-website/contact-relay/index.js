// Shared contact-form relay.
//
// Two static marketing sites (Shuffly and StockPing) are served by nginx on
// this box, and neither can send mail on its own. Both proxy their own
// same-origin `POST /api/contact` here, and this turns a submission into an
// email to CONTACT_TO_EMAIL over the Gmail API.
//
// This service is deliberately product-agnostic: no product name appears
// anywhere below. The brand and the site name shown in the email come from
// `sites.json`, looked up by the Host header nginx forwards. Adding a third
// site is a config entry, not a code change.
//
// Branding is keyed off the *host* rather than a field in the request body on
// purpose. The endpoint is public, so a body field would let anyone send this
// mailbox an email captioned however they liked; the Host header is set by
// nginx, not by the caller.
//
// Mail goes out through Gmail as the authenticated GMAIL_FROM_EMAIL user.
// That matters for deliverability: mpctrades.com publishes
// `v=spf1 include:_spf.google.com ~all`, so mail sent directly from this VPS
// would fail SPF. The From *display name* is per-site; the address is shared,
// because it is the one Google-authenticated identity available.

const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = process.env.PORT || 3002;
const TO_EMAIL = process.env.CONTACT_TO_EMAIL;

// GMAIL_FROM_EMAIL may be a bare address or an already-decorated
// `Name <addr>` value - it is currently the latter, which is where the old
// hardcoded-looking From name actually came from. Only the address part is
// ours to reuse, because the display name is per-site now; reusing the whole
// string would nest brackets and produce an invalid From header.
function bareAddress(value) {
  const match = String(value == null ? "" : value).match(/<([^>]*)>/);
  return (match ? match[1] : String(value == null ? "" : value)).trim();
}

const FROM_ADDRESS = bareAddress(process.env.GMAIL_FROM_EMAIL);

const MAX_BODY_BYTES = 20 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const hits = new Map();

// Every accepted submission is appended here with the outcome of its send,
// so a lead survives a Gmail outage instead of existing only as an email that
// never arrived. See `outcome` on each line: "sent" or "send_failed".
const LOG_PATH = process.env.SUBMISSION_LOG || path.join(__dirname, "submissions.log");

// Host -> { brand, site }. Read once at startup; restart to pick up edits.
const SITES = JSON.parse(fs.readFileSync(path.join(__dirname, "sites.json"), "utf8"));

// Used when a request arrives on a host that isn't in sites.json. Answering
// with a neutral brand rather than rejecting means a misconfigured or new
// vhost still delivers the lead; the warning below is how we find out.
const FALLBACK_SITE = { brand: "Website", site: "" };

function siteFor(req) {
  const raw = req.headers.host || "";
  const host = raw.split(":")[0].toLowerCase();
  if (SITES[host]) return { ...SITES[host], host };
  console.warn(`[relay] no sites.json entry for host ${JSON.stringify(host)} - using neutral branding`);
  return { ...FALLBACK_SITE, site: host || "(unknown host)", host };
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || [];
  const recent = entry.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

// Required lazily: only the send path needs it, so the header tests can
// exercise this module without the dependency installed.
function oauthClient() {
  const { google } = require("googleapis");
  const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Anything bound for a header has to stay on one line: a CR or LF here would
// otherwise let a submission append headers of its own.
function oneLine(value, max) {
  return String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

// A display name inside a quoted string can't contain a quote or a backslash.
function quotedName(value) {
  return oneLine(value, 100).replace(/["\\]/g, "");
}

function buildRawMessage({ from, to, replyTo, subject, html }) {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
  ].join("\r\n");
  return Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The exact header set this submission will be sent with. Split out from the
// send so it can be logged and asserted on without talking to Gmail.
function composeHeaders(fields, site) {
  const name = oneLine(fields.name, 200);
  // `topic` is the field name both sites send now. `reason` is the older
  // name StockPing's form used; honoured so an un-redeployed site keeps
  // working. Resolved here rather than at the call site so it is covered by
  // the header tests and cannot be bypassed.
  const topic = oneLine(fields.topic || fields.reason, 100) || "Get in touch";

  const rows = [
    ["Topic", topic],
    ["Name", name],
    ["Email", fields.email],
    ["Store", fields.store || "(not provided)"],
  ]
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#57625c;">${k}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("");

  const html = `
    <div style="font:14px system-ui,sans-serif;color:#11161c;">
      <h2 style="margin:0 0 12px;">New message from ${escapeHtml(site.site)}</h2>
      <table style="border-collapse:collapse;margin-bottom:16px;">${rows}</table>
      <p style="white-space:pre-wrap;border-top:1px solid #ddd;padding-top:12px;">${escapeHtml(fields.message || "(no message)")}</p>
    </div>`;

  return {
    from: `"${quotedName(site.brand)}" <${FROM_ADDRESS}>`,
    to: TO_EMAIL,
    // The whole point of the relay: hitting Reply goes to the person who
    // filled in the form, not to the mailbox that did the sending.
    replyTo: `"${quotedName(name)}" <${fields.email}>`,
    subject: `${oneLine(site.brand, 40)} contact — ${topic} — ${name}`,
    html,
  };
}

async function sendContactEmail(headers) {
  const { google } = require("googleapis");
  const auth = oauthClient();
  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: buildRawMessage(headers) } });
}

function logSubmission(entry) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Never fail a submission because the log is unwritable; journald still
    // has the console copy below.
    console.error("[relay] could not append to submission log:", err.message);
  }
  console.log("[relay]", JSON.stringify(entry));
}

function isValidEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/api/contact") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    sendJson(res, 429, { error: "rate_limited" });
    return;
  }

  let body = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
    }
  });

  req.on("end", async () => {
    if (tooLarge) {
      sendJson(res, 413, { error: "payload_too_large" });
      return;
    }
    let fields;
    try {
      fields = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    // Honeypot. Both sites ship a field no human sees; if it came back
    // filled, answer 200 so the bot counts it a success and send nothing.
    if (fields.company || fields.botcheck) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!fields.name || !isValidEmail(fields.email) || !fields.message) {
      sendJson(res, 400, { error: "invalid_fields" });
      return;
    }

    const site = siteFor(req);
    const headers = composeHeaders(
      {
        name: String(fields.name).slice(0, 200),
        email: String(fields.email).slice(0, 200),
        store: fields.store ? String(fields.store).slice(0, 200) : "",
        topic: fields.topic ? String(fields.topic).slice(0, 200) : "",
        reason: fields.reason ? String(fields.reason).slice(0, 200) : "",
        message: String(fields.message).slice(0, 5000),
      },
      site
    );

    const record = {
      at: new Date().toISOString(),
      host: site.host,
      brand: site.brand,
      from: headers.from,
      replyTo: headers.replyTo,
      subject: headers.subject,
      store: fields.store ? String(fields.store).slice(0, 200) : "",
      message: String(fields.message).slice(0, 5000),
    };

    try {
      await sendContactEmail(headers);
      logSubmission({ ...record, outcome: "sent" });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      // The lead is already on disk at this point, so a Gmail failure costs
      // us the notification, not the enquiry.
      logSubmission({ ...record, outcome: "send_failed", error: err.message });
      console.error("send failed:", err.message);
      sendJson(res, 502, { error: "send_failed" });
    }
  });
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[relay] listening on 127.0.0.1:${PORT} for ${Object.keys(SITES).length} configured sites`);
  });
}

// Exported so the header composition can be tested without a Gmail round-trip.
module.exports = { composeHeaders, siteFor, buildRawMessage, bareAddress, server };
