# shuffly-contact-api

> **NOT DEPLOYED.** The live form does not use this service.
> `shuffly.mpctrades.com/api/contact` is proxied to the shared
> `contact-relay.service` on `127.0.0.1:3002` (source: `../contact-relay/`),
> which sends via the Gmail API to team@mpctrades.com.
>
> It used to be kept because the relay hardcoded StockPing's branding. That
> is fixed — the relay is now product-agnostic and brands each email from the
> host it was posted to, so Shuffly enquiries arrive as
> `Shuffly contact — {topic} — {name}` with no code change needed here.
>
> What this service still offers is *full* separation: its own process, its
> own credential, no shared dependency on a service that lives in another
> product's home directory. Taking that step needs a sending credential of
> its own — a Gmail App Password for team@mpctrades.com in `.env` (see
> `.env.example`) — which is why it is not deployed. Once there is one:
> bring the container up on 3007 and repoint the nginx
> `location = /api/contact` from 3002 to 3007.

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
