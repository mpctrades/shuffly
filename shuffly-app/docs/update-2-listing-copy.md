# Update 2 — App Store listing and pricing copy (EN + FR)

For Arthur. Nothing here has been published; the Partner Dashboard is yours to update. Prices do not change: Free $0 / Starter $3.99 / Pro $7.99.

**Rules this copy follows**
- "Unlimited" always appears with "as often as every hour". The app enforces a 1-hour minimum on every plan, so "unlimited" alone would overclaim.
- No prices in the listing description, subtitle or screenshots (already a rule in `APP_STORE_REVIEW.md`). Prices go only in the pricing section.
- No speed claims for Feature B. The app checks every 15 minutes and waits 10 minutes for imports to settle, so a new product is shuffled in roughly 10–25 minutes. The copy says "automatically", never "instantly" or "in real time".

> ⚠️ **About the French listing.** `APP_STORE_REVIEW.md` §Listing says to keep English as the only listing language *unless the entire embedded UI is translated*. That reflects Shopify's rule that every language a listing offers must be supported by the app's UI. After this update, the French UI covers the Collections screen, the collection card, the "New arrivals" setup, the plan-change notice, the new Activity messages and the app menu. **Activity (older messages), Insights, Settings, Plan, Help, Onboarding and the dialogs are still English.** The French text below is ready, but I recommend **not publishing a French listing until those screens are translated.** Your call.

---

## 1. Main bullet (key benefits)

| | Current | New |
|---|---|---|
| EN | Scheduled rotation: daily, twice daily, or weekly | **Scheduled rotation: from every hour to weekly, set per collection** |
| FR | — | **Rotation planifiée : de toutes les heures à une fois par semaine, collection par collection** |

## 2. Pro plan bullets (added)

| EN | FR |
|---|---|
| **Unlimited shuffles — as often as every hour** | **Mélanges illimités — jusqu'à toutes les heures** |
| Reshuffle automatically when new products arrive | Remélange automatique dès que de nouveaux produits arrivent |
| Keep new arrivals on top | Vos nouveautés restent en tête |

Optional fourth bullet, if the listing has room. It's true: the one-click setup ships in this update.

| EN | FR |
|---|---|
| One-click "New arrivals" setup | Réglage « Nouveautés » en un clic |

## 3. Pricing page (managed pricing plan descriptions)

Free and Starter **do not change**. They're included so the three plans read consistently side by side.

### English

**Free — $0**
- Up to 25 collections
- Weekly shuffles
- Sold-out products to the end
- Shuffle now, any time

**Starter — $3.99/month**
- Up to 100 collections
- Daily shuffles at a time you pick
- Pin your best sellers
- 7-day undo history

**Pro — $7.99/month**
- Unlimited collections
- Unlimited shuffles — as often as every hour
- Reshuffle automatically when new products arrive
- Keep new arrivals on top
- 30-day undo history

### Français

**Free — 0 $**
- Jusqu'à 25 collections
- Mélange hebdomadaire
- Produits épuisés en fin de liste
- « Mélanger maintenant » à tout moment

**Starter — 3,99 $/mois**
- Jusqu'à 100 collections
- Mélange quotidien à l'heure de votre choix
- Épinglez vos meilleures ventes
- Historique d'annulation de 7 jours

**Pro — 7,99 $/mois**
- Collections illimitées
- Mélanges illimités — jusqu'à toutes les heures
- Remélange automatique dès que de nouveaux produits arrivent
- Vos nouveautés restent en tête
- Historique d'annulation de 30 jours

**Undo on Free:** the brief's table shows "—" for Free, but the app keeps **1 day** of undo on Free (`PLANS.FREE.undoRetentionDays = 1`). I left it out of the Free list rather than claim either. If you want it listed, "1-day undo" / « Annulation sur 1 jour » is accurate.

## 4. In-app copy already updated in this branch

- `/app/plan` lists "Unlimited shuffles — as often as every hour", "Reshuffle automatically when new products arrive" and "Keep new arrivals on top" for Pro (current plan and upgrade gains).
- The plan bar on Collections says "Unlimited shuffles — as often as every hour" for Pro and no longer says "2 time slots".
- The public landing page (`/`) says "From every hour to weekly, set per collection — fully automatic." (was "Daily, twice daily, or weekly").

## 5. New screenshot

One screenshot of the **new collection card**, ideally:
- A collection titled **"New Arrivals"** with about 1,000 products, on **Every 2 hours**, with both new-arrivals options ticked and **48 h** selected.
- "Next shuffle in 42 min" visible, plus "3 pinned · 2 excluded" and a "Last run: today …" footer with **Undo**.
- A second card below on a Starter-style schedule (Daily) for contrast, if it fits.
- English admin. Desktop width (1600 px wide for the listing's 16:9 frame). No prices in the image.

Caption (EN): "One card per collection: how often, new arrivals, fixed products."
Caption (FR): « Une fiche par collection : fréquence, nouveautés, produits fixes. »
