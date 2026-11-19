// Guards the bug where opening a collection changed the URL but kept showing
// the Collections list: with flat routes, app.collections.$id.tsx is a CHILD
// of app.collections.tsx, and a child only appears if its parent renders an
// <Outlet />. A page meant to stand alone opts out with a trailing
// underscore on the parent segment (app.collections_.$id.tsx).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROUTES = "app/routes";

/** A route file that renders a page (has a default export), not a resource
 * route (loader/action only) — only pages can be "hidden" by a parent. */
function rendersPage(src: string): boolean {
  return /export default function/.test(src);
}

describe("flat-route nesting", () => {
  it("every page nested under a parent page has a parent that renders <Outlet />", () => {
    const files = readdirSync(ROUTES).filter((f) => /\.tsx$/.test(f));
    const byId = new Map(files.map((f) => [f.replace(/\.tsx$/, ""), readFileSync(`${ROUTES}/${f}`, "utf8")]));
    const problems: string[] = [];
    for (const [id, src] of byId) {
      if (!rendersPage(src)) continue;
      const segments = id.split(".");
      // Nearest existing ancestor route file (segments with a trailing "_"
      // break nesting, so they never match a parent id).
      for (let n = segments.length - 1; n > 0; n--) {
        const parentId = segments.slice(0, n).join(".");
        const parent = byId.get(parentId);
        if (!parent) continue;
        if (rendersPage(parent) && !/<Outlet\b/.test(parent)) {
          problems.push(`${id}.tsx would render inside ${parentId}.tsx, which has no <Outlet />`);
        }
        break;
      }
    }
    expect(problems).toEqual([]);
  });
});
