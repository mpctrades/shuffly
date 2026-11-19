# Shuffly marketing site

The public site at https://shuffly.mpctrades.com/ is a single static page,
`index.html`, plus the `assets/` folder. There's no build step and no framework:
everything is inline, and the page should stay around 100 KB.

```
index.html                     the whole page (HTML, CSS, JS inline)
assets/og-image.png            1200×630 link-preview image (og:image / twitter:image)
assets/favicon.png             128×128 favicon / apple-touch-icon
assets/screenshots/*.png       real app screenshots (1×1 placeholders until replaced)
tools/og-image.html            source for og-image.png (not deployed)
contact-relay/, contact-api/   the /api/contact form relay (deployed separately)
```

## Launch switch: early access → live on the App Store

Every install call to action (the nav button, the hero button, and the three
pricing buttons) is controlled by one config block at the top of `<head>` in
`index.html`:

```js
window.SHUFFLY_SITE = {
  LAUNCH_MODE: "early-access",   // "early-access" | "live"
  APP_STORE_URL: ""              // e.g. "https://apps.shopify.com/shuffly"
};
```

To go live once Shopify approves the listing:

1. Set `APP_STORE_URL` to the listing's full `https://apps.shopify.com/...` URL.
2. Set `LAUNCH_MODE` to `"live"`.
3. Deploy (see below).

What "live" changes:

- Every element marked `data-cta` reads **Install on Shopify** and opens
  `APP_STORE_URL` in a new tab.
- Every element marked `data-early-only` is hidden: the "Is Shuffly on the
  App Store yet?" FAQ, the "submitted for review" sentence in the footer, the
  "Early access is free while we build" line, and the "Early access" topic in
  the contact form.
- Elements with `data-live-text` swap to that text (the contact heading
  becomes "Questions before you install?").

Safety net: `"live"` only takes effect when `APP_STORE_URL` is a real
`https://` link. With an empty URL the page stays in early access and logs a
console warning, so a half-finished switch can't ship dead buttons.

`"early-access"` renders the static markup exactly as written. The script
changes nothing in that mode.

## Real screenshots

Two spots are ready for real screenshots:

| File | Where it shows |
| --- | --- |
| `assets/screenshots/collections.png` | How it works, step 1 (Collections panel) |
| `assets/screenshots/insights.png` | Insights section (06) |

Each spot shows its drawn mock-up until a real image loads. The shipped files
are 1×1 transparent placeholders, and anything 1 pixel wide is ignored. To
switch, overwrite the PNG with a real screenshot and deploy. No code changes
are needed.

- Recommended size: **1600×1000** (16:10). Other sizes work, but the image is
  cropped from the top-left to fit the frame.
- Keep each file under ~250 KB (export as PNG-8 or run it through an optimiser).
- Take them from a demo store. The Insights frame is captioned "Screenshot
  from our demo store", so don't use a merchant's real data.

## Link previews (Open Graph)

The `og:*` and `twitter:*` tags in `<head>` reuse the page `<title>` and meta
description. The image is `assets/og-image.png`, referenced by absolute URL.
To regenerate it, edit `tools/og-image.html` and run:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 \
  --screenshot=assets/og-image.png "file://$PWD/tools/og-image.html"
```

After deploying a new image, social networks keep their cached preview until
you re-scrape it (for example with Facebook's Sharing Debugger).

## Copy rules

These must hold everywhere on the page:

- Never invent metrics or performance claims. Insights numbers are
  before/after, never causal. Mock-ups are labelled "Illustrative example".
- New products are reshuffled **10–25 minutes** after they're added. Never
  say "instant".
- Exclusions work by **shop-wide tag only**, never by product type or vendor.
- "Zero storefront impact" means no theme edits and no scripts. Keep it accurate.
- Never name competitors. Comparison cells we can't back up read "Varies".

## Deploy

The site lives on srv1897818 (`root@187.52.115.100`, not the `vps` alias),
served by nginx from `/var/www/shuffly/`. Static files only: no reload needed.

```sh
# from the repo root
ssh root@187.52.115.100 'cd /var/www/shuffly && cp -p index.html index.html.bak-$(date +%Y%m%d%H%M%S)'
rsync -rvz --checksum shuffly-website/index.html shuffly-website/assets root@187.52.115.100:/var/www/shuffly/
ssh root@187.52.115.100 'chown -R root:root /var/www/shuffly'
```

Verify that `curl -s https://shuffly.mpctrades.com/ | md5` matches `md5 -q shuffly-website/index.html`.
