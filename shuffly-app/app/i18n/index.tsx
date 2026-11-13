// A deliberately small i18n layer (Update 2). Shuffly had a `language`
// column and no translations at all; this adds EN + FR for the Collections
// screen, the collection card, the "New arrivals" preset, the plan notice
// and the new Activity messages. The rest of the app is still English-only
// (see docs/update-2-qa.md) and moves over screen by screen.
//
// No library: two flat dictionaries, `{name}` placeholders, and CLDR plural
// categories from Intl.PluralRules — which matters for French, where 0 and 1
// are both singular ("0 produit", "1 produit", "2 produits").

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { en, type MessageKey } from "./en";
import { fr } from "./fr";

export type Lang = "en" | "fr";
export type { MessageKey };

const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { en, fr };

/** Shopify passes the admin user's locale ("fr", "fr-CA", "en-US") on the
 * embedded app URL; anything we don't translate falls back to English. */
export function normalizeLang(locale: string | null | undefined): Lang | null {
  if (!locale) return null;
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return base === "fr" ? "fr" : base === "en" ? "en" : null;
}

export type Vars = Record<string, string | number>;

function interpolate(template: string, vars: Vars | undefined, lang: Lang): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v == null) return `{${name}}`;
    return typeof v === "number" ? new Intl.NumberFormat(lang).format(v) : v;
  });
}

export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  return interpolate(DICTIONARIES[lang][key] ?? en[key], vars, lang);
}

/** Plural-aware lookup: `${key}_one` / `${key}_other`, chosen by the
 * language's own rules for `count` (exposed to the template as {count}). */
export function translatePlural(lang: Lang, key: string, count: number, vars?: Vars): string {
  const category = new Intl.PluralRules(lang).select(count) === "one" ? "one" : "other";
  return translate(lang, `${key}_${category}` as MessageKey, { count, ...vars });
}

export interface T {
  (key: MessageKey, vars?: Vars): string;
  plural: (key: string, count: number, vars?: Vars) => string;
  lang: Lang;
}

export function makeT(lang: Lang): T {
  const t = ((key: MessageKey, vars?: Vars) => translate(lang, key, vars)) as T;
  t.plural = (key, count, vars) => translatePlural(lang, key, count, vars);
  t.lang = lang;
  return t;
}

const LangContext = createContext<Lang>("en");

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useT(): T {
  const lang = useContext(LangContext);
  return useMemo(() => makeT(lang), [lang]);
}
