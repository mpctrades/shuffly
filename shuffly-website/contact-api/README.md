# shuffly-contact-api

> **NOT CURRENTLY DEPLOYED.** The live form does not use this service.
> `shuffly.mpctrades.com/api/contact` is proxied to the pre-existing
> `contact-relay.service` on `127.0.0.1:3002` instead, which already sends via
> the Gmail API to team@mpctrades.com and needed no new credential.
>
> This service is kept because it is the path to *Shuffly-branded* enquiry
> emails: the shared relay hardcodes StockPing's subject and heading, so
> enquiries currently arrive titled `StockPing contact - Shuffly - ...`. To
> switch over, put an SMTP App Password in `.env` (see `.env.example`), bring
> the container up, and repoint the nginx `location = /api/contact` from 3002
> back to 3007.

The contact form on `shuffly.mpctrades.com` posts here. The marketing site
itself is a single static `index.html` served by nginx; this is the only
backend behind it.

## Why it exists

A static page can't send mail. The alternative was a third-party form relay
(Web3Forms, FormSubmit), which needs an account and puts merchant enquiries
through someone else's server. This sends directly over Gmail SMTP as
`team@mpctrades.com` instead, reusing the same App Password approach as
`fulfillflex-landing`.

Sending as a Google-authenticated user matters: `mpctrades.com`'s SPF record
is `v=spf1 include:_spf.google.com ~all`, so mail sent straight from the VPS
would fail SPF and land in spam.

## Deploy (srv1897818 / 187.52.115.100)

Lives at `/opt/shuffly-contact`, listening on `127.0.0.1:3007`, proxied by
nginx from `shuffly.mpctrades.com/api/contact` so the browser request is
same-origin and needs no CORS.

    rsync -avz --exclude .env ./ root@187.52.115.100:/opt/shuffly-contact/
    ssh root@187.52.115.100 'cd /opt/shuffly-contact && docker compose up -d --build'

`.env` is deliberately **not** in the repo and not rsynced — it holds the
App Password and lives only on the server, chmod 600. See `.env.example`.

    curl -s https://shuffly.mpctrades.com/api/contact -X POST \
      -H 'Content-Type: application/json' \
      -d '{"name":"Test","email":"you@example.com","message":"hello"}'
