# contact-relay

The mail relay behind the contact form on **both** marketing sites:
`shuffly.mpctrades.com` and `stockping-web.mpctrades.com`. Each site is a
static `index.html` served by nginx, so neither can send mail itself; both
proxy their own same-origin `POST /api/contact` here.

Deployed outside this repo, and **not** as part of the Shuffly deploy:

| | |
|---|---|
| Host | srv1897818 / 187.52.115.100 |
| Path | `/home/devteam02/contact-relay` |
| Service | `contact-relay.service` (systemd), runs as `devteam02` |
| Listens | `127.0.0.1:3002` |

It is tracked here because Shuffly depends on it and nothing else version
controls it. Deploying it touches another product — see *Deploy* below.

## Per-site branding

No product name appears in `index.js`. The From display name, the subject
prefix and the "New message from …" heading all come from `sites.json`,
looked up by the `Host` header nginx forwards:

```json
"shuffly.mpctrades.com": { "brand": "Shuffly", "site": "shuffly.mpctrades.com" }
```

Producing:

```
From:    Shuffly <…>
Subject: Shuffly contact — {topic} — {name}
Body:    New message from shuffly.mpctrades.com
```

Branding is keyed on the host rather than a field in the request body
deliberately. The endpoint is public, so a body field would let anyone send
this mailbox an email captioned however they liked; `Host` is set by nginx,
not by the caller. A host with no entry still delivers, under the neutral
brand `Website`, and logs a warning — a config gap should not cost a lead.

Adding a site is an entry in `sites.json` plus a restart. No code change.

## Reply-To

`Reply-To` is the person who filled in the form, as
`"Their Name" <their@email>`. Hitting Reply in the notification answers the
merchant, not the sending mailbox. This is asserted in `headers.test.js`;
don't regress it.

## Request contract

`POST /api/contact`, JSON:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | |
| `email` | yes | must parse; becomes `Reply-To` |
| `message` | yes | truncated at 5000 chars |
| `store` | no | |
| `topic` | no | subject middle; defaults to `Get in touch` |
| `reason` | no | older name for `topic`, still honoured |
| `company` / `botcheck` | no | honeypot — if filled, answers `200` and sends nothing |

Errors are machine codes, not prose: `invalid_json`, `invalid_fields`,
`rate_limited` (5/hour/IP), `payload_too_large` (20 KB), `send_failed`. The
calling site translates them.

## Every submission is logged

Each accepted submission is appended to `submissions.log` as one JSON object,
including `outcome: "sent" | "send_failed"` and the full message body, so a
Gmail outage costs the notification rather than the enquiry. Recover leads
with:

    grep '"send_failed"' /home/devteam02/contact-relay/submissions.log

The file grows without bound and holds enquiry text from both products —
worth a logrotate rule before it matters.

## Sending identity

Mail goes out through the Gmail API as the authenticated `GMAIL_FROM_EMAIL`
user. `mpctrades.com` publishes `v=spf1 include:_spf.google.com ~all`, so
sending straight from the VPS would fail SPF and land in spam. The From
*address* is therefore shared between products; only the display name differs.

`.env` (chmod 600, server only, never in this repo): `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GMAIL_FROM_EMAIL`,
`CONTACT_TO_EMAIL`, `PORT`.

## Test

    npm test

Covers the From name, subject shape and Reply-To for both sites, host
resolution, the legacy `reason` field, and CRLF/quote header injection. No
Gmail round-trip, so it runs anywhere.

## Deploy

This restarts the endpoint **StockPing's form also uses**. Test both sites
afterwards.

    rsync -avz --exclude node_modules --exclude .env --exclude submissions.log \
      ./ root@187.52.115.100:/home/devteam02/contact-relay/
    ssh root@187.52.115.100 'chown -R devteam02:devteam02 /home/devteam02/contact-relay \
      && systemctl restart contact-relay'
