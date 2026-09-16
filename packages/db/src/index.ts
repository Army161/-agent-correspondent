export * as schema from "./schema";
export * from "./schema";
export * from "./client";
export * from "./money";

/**
 * The query-builder surface, re-exported.
 *
 * Callers import these from `@acor/db` rather than from `drizzle-orm` directly
 * so the whole workspace resolves exactly one copy of the library. Two copies
 * produce two incompatible sets of nominal types, and every query stops
 * typechecking for reasons that have nothing to do with the query.
 */
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
