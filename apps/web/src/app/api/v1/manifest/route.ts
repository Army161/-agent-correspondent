/**
 * The capability manifest, as JSON.
 *
 * Public and unauthenticated on purpose: anyone assessing what this product
 * actually supports should be able to read the same statuses the site renders,
 * from the same source, without taking our word for it.
 */

import { NextResponse } from "next/server";

import { getCapabilityManifest } from "@/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const manifest = await getCapabilityManifest();
  return NextResponse.json(manifest, {
    headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" },
  });
}
