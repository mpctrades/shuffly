import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";
import logo from "../../assets/brand/shuffly-icon-orange-1200.png";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.content}>
        <div className={styles.brand}>
          <img src={logo} alt="" className={styles.logo} width={64} height={64} />
          <div className={styles.wordmark}>
            Shuffly<span className={styles.wordmarkDot}>.</span>
          </div>
        </div>

        <div className={styles.eyebrow}>For Shopify merchants</div>
        <h1 className={styles.heading}>
          Your collections, fresh every morning.
        </h1>
        <p className={styles.text}>
          Shuffly re-orders your Shopify collections on a schedule. Sold-out
          products drop to the end, new arrivals get their turn — no theme
          changes, no scripts, nothing customers notice.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.fieldLabel} htmlFor="shop">
              Shop domain
            </label>
            <div className={styles.fieldRow}>
              <input
                id="shop"
                className={styles.input}
                type="text"
                name="shop"
                defaultValue="shuffly-kd37m7ec.myshopify.com"
              />
              <button className={styles.button} type="submit">
                Log in
              </button>
            </div>
            <span className={styles.hint}>e.g: my-shop-domain.myshopify.com</span>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <div className={styles.icon} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3.5 2" />
              </svg>
            </div>
            <strong>Shuffle on a schedule.</strong>
            <p>Daily, twice daily, or weekly — fully automatic.</p>
          </li>
          <li>
            <div className={styles.icon} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z" />
                <circle cx="12" cy="10" r="2.5" />
              </svg>
            </div>
            <strong>Pin what shouldn&apos;t move.</strong>
            <p>Lock your best sellers at the top while the rest rotates.</p>
          </li>
          <li>
            <div className={styles.icon} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
              </svg>
            </div>
            <strong>Reacts to sold-out stock in real time.</strong>
            <p>Sold-out products drop to the end within a minute.</p>
          </li>
        </ul>

        <p className={styles.footer}>
          <a href="/privacy">Privacy policy</a>
        </p>
      </div>
    </div>
  );
}
