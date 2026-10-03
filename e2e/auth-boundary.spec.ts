/**
 * The authentication boundary, enumerated from the code.
 *
 * Every route handler under app/api/v1 is discovered from the filesystem and
 * called with no credentials and with a well-formed but unknown API key. Each
 * must refuse, except the routes on the explicit public allowlist below. A new
 * route that forgets to authenticate fails this test without anyone having to
 * remember to add it here.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

const API_ROOT = join(process.cwd(), "apps", "web", "src", "app", "api", "v1");

/** Deliberately public, each for a stated reason. */
const PUBLIC = new Set([
  "GET /api/v1/manifest", // what this deployment can do -- shown on the landing page
  "GET /api/v1/network/capabilities", // live rail state, no tenant data
  "GET /api/v1/credentials/issuer", // the public key verifiers need offline
  "GET /api/v1/credentials/revoked", // revocation list: ids only
  "POST /api/v1/credentials/verify", // counterparties are not our customers
]);

function routes(): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") {
        const source = readFileSync(full, "utf8");
        const route = relative(API_ROOT, dir).split(sep).join("/");
        const path = `/api/v1${route ? `/${route}` : ""}`;
        for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
          found.push({ method: match[1]!, path });
        }
      }
    }
  };
  walk(API_ROOT);
  return found;
}

async function databaseConfigured(request: APIRequestContext): Promise<boolean> {
  const body = (await (await request.get("/api/health")).json()) as { database: { status: string } };
  return body.database.status === "CONNECTED";
}

test("the route list was actually discovered", () => {
  // Guards the guard: a path change that found nothing would pass vacuously.
  expect(routes().length).toBeGreaterThan(25);
});

test("every non-public route refuses an unauthenticated caller and an unknown API key", async ({ request }) => {
  const connected = await databaseConfigured(request);
  const failures: string[] = [];

  for (const { method, path } of routes()) {
    const key = `${method} ${path}`;
    if (PUBLIC.has(key)) continue;
    const url = path.replace(/\[[^\]]+\]/g, "boundary_probe_id");

    for (const [label, headers] of [
      ["no credentials", {}],
      ["unknown API key", { authorization: `Bearer acor_sk_${"0".repeat(64)}` }],
    ] as const) {
      const response = await request.fetch(url, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(method === "GET" ? {} : { data: {} }),
      });
      const status = response.status();
      // Without a database, refusing with 503 before authenticating is also a
      // refusal; with one, the answer must be an authentication failure.
      const allowed = connected ? [401, 403] : [401, 403, 503];
      if (!allowed.includes(status)) failures.push(`${key} (${label}) -> ${status}`);
    }
  }

  expect(failures, failures.join("\n")).toEqual([]);
});

test("every public route answers without credentials", async ({ request }) => {
  for (const key of PUBLIC) {
    const [method, path] = key.split(" ") as [string, string];
    const response = await request.fetch(path!, {
      method,
      ...(method === "POST" ? { data: { document: {}, signature: "0".repeat(32) } } : {}),
    });
    // 503 is fine (e.g. no issuer key configured); demanding credentials is not.
    expect([401, 403], key).not.toContain(response.status());
  }
});
