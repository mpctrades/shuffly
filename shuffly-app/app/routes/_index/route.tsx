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
      <div className={styles.content}>
        <img src={logo} alt="Shuffly" className={styles.logo} width={64} height={64} />
        <h1 className={styles.heading}>
          Your collections, fresh every morning.
        </h1>
        <p className={styles.text}>
          Shuffly automatically re-orders the products inside your Shopify
          collections on a schedule you set — so the same handful of items
          don&apos;t sit at the top forever, sold-out products get pushed out of
          the way, and new arrivals get their turn. No theme changes, no
          scripts, nothing for customers to notice except a catalogue that
          always feels current.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                defaultValue="shuffly-kd37m7ec.myshopify.com"
              />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Shuffle on a schedule.</strong> Daily, twice daily, or
            weekly — pick the quiet hour and Shuffly re-orders every collection
            you&apos;ve added automatically.
          </li>
          <li>
            <strong>Pin what shouldn&apos;t move.</strong> Keep your best
            sellers or featured picks locked at the top while everything else
            rotates underneath.
          </li>
          <li>
            <strong>Reacts to sold-out stock in real time.</strong> A product
            selling out gets pushed to the end within a minute — no need to wait
            for the next scheduled run.
          </li>
        </ul>
        <p className={styles.footer}>
          <a href="/privacy">Privacy policy</a>
        </p>
      </div>
    </div>
  );
}
