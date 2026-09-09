# shuffly-contact-api

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
