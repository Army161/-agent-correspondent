/**
 * The backfill migration hard-codes each asset's decimal scale in SQL, because
 * a migration cannot import TypeScript. That duplication is a hazard: if the
 * registry gains an asset, or an asset's scale is corrected, the SQL silently
 * keeps the old answer and a future backfill writes wrong numbers.
 *
 * This test reads the SQL and compares it to the registry, so the duplication
 * cannot drift unnoticed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assetDefinition, isUsdPegged, listAssets } from "@acor/core";

const MIGRATION = readFileSync(
  join(__dirname, "..", "migrations", "0003_backfill_asset_amounts.sql"),
  "utf8",
);

function sqlDecimals(): Map<string, number> {
  const body = MIGRATION.slice(
    MIGRATION.indexOf("CREATE OR REPLACE FUNCTION acor_asset_decimals"),
    MIGRATION.indexOf("$$ LANGUAGE sql IMMUTABLE;", MIGRATION.indexOf("acor_asset_decimals")),
  );
  const out = new Map<string, number>();
  for (const match of body.matchAll(/WHEN\s+'([^']+)'\s+THEN\s+(\d+)/g)) {
    out.set(match[1] as string, Number(match[2]));
  }
  return out;
}

function sqlUsdPar(): Set<string> {
  const body = MIGRATION.slice(
    MIGRATION.indexOf("CREATE OR REPLACE FUNCTION acor_is_usd_par"),
    MIGRATION.indexOf("$$ LANGUAGE sql IMMUTABLE;", MIGRATION.indexOf("acor_is_usd_par")),
  );
  return new Set([...body.matchAll(/'([A-Z_]+:[A-Z]+)'/g)].map((m) => m[1] as string));
}

describe("migration/registry parity", () => {
  it("found the SQL tables it is checking", () => {
    expect(sqlDecimals().size).toBeGreaterThan(5);
    expect(sqlUsdPar().size).toBeGreaterThan(3);
  });

  it("agrees with the asset registry on every scale it declares", () => {
    for (const [assetId, decimals] of sqlDecimals()) {
      const definition = assetDefinition(assetId);
      expect(definition, `${assetId} is in the migration but not in the registry`).toBeDefined();
      expect(definition?.decimals, `${assetId} scale`).toBe(decimals);
    }
  });

  it("agrees with the asset registry on which assets are USD-par", () => {
    for (const assetId of sqlUsdPar()) {
      expect(isUsdPegged(assetId), `${assetId} is USD-par in SQL but not in the registry`).toBe(
        true,
      );
    }
    for (const definition of listAssets()) {
      // Issuer-scoped assets are registered dynamically at runtime and are not
      // expected in the migration, which only backfills historical rows.
      if (definition.id.split(":").length > 2) continue;
      if (definition.peg.kind !== "USD_PAR") continue;
      expect(
        sqlUsdPar().has(definition.id),
        `${definition.id} is USD-par in the registry but the migration would not carry its USD value over`,
      ).toBe(true);
    }
  });

  it("covers every statically registered asset", () => {
    const declared = sqlDecimals();
    for (const definition of listAssets()) {
      if (definition.id.split(":").length > 2) continue;
      expect(
        declared.has(definition.id),
        `${definition.id} is registered but the migration cannot resolve its scale`,
      ).toBe(true);
    }
  });
});
