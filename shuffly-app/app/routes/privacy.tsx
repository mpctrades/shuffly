// Public, unauthenticated page — required for the Shopify App Store
// listing. This is a starting draft; have it reviewed before submitting.
export default function Privacy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
      <h1>Shuffly Privacy Policy</h1>
      <p>Last updated: [fill in before publishing]</p>

      <h2>What Shuffly accesses</h2>
      <p>
        Shuffly requests two Shopify Admin API scopes: <code>read_products</code> and <code>write_products</code>.
        It uses these only to read your product catalogue and collections, and to set the position of products
        inside collections you&apos;ve chosen to have it manage. Shuffly does not request access to customer data,
        order data, or your storefront theme.
      </p>

      <h2>What Shuffly stores</h2>
      <p>
        For each store that installs Shuffly, we store: your shop domain, timezone, and notification preferences;
        which collections you&apos;ve added and how you&apos;ve configured them (pin count, toggles, schedule); and
        a rolling history of shuffle runs (used to power Undo). We do not store product content beyond what&apos;s
        needed to display it inside the app, and we never store customer or order information.
      </p>

      <h2>Data retention and deletion</h2>
      <p>
        If you uninstall Shuffly, all data associated with your shop is deleted within 48 hours. Your collections
        keep whatever order they had at the time of uninstall — Shuffly does not revert anything.
      </p>

      <h2>Third parties</h2>
      <p>
        Shuffly does not sell or share your store&apos;s data with third parties. Billing is handled entirely
        through Shopify&apos;s Billing API — Shuffly never sees your payment details.
      </p>

      <h2>Contact</h2>
      <p>Questions about this policy or your data: [support email].</p>
    </main>
  );
}
