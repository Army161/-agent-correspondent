/**
 * Compile an EconomicIntent.
 *
 * The response contains the intent, its canonical hash and the EIP-712 typed
 * data ready for a wallet to sign. Compiling spends nothing and commits
 * nothing: the authorization only exists once a human or a key-holding agent
 * signs it, and the mandate engine checks it again at execution.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { keccak256 } from "@acor/adapters";
import {
  buildIntentTypedData,
  compileIntent,
  describeIntent,
  hashIntent,
  intentHash,
  intentToWire,
} from "@acor/core";

import {
  authenticateRequest,
  badRequest,
  readJson,
  unauthorized,
  violations,
} from "@/lib/api";
import { createRelay } from "@/lib/relay";
import { recordAudit } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List intents, newest first. Expiry is evaluated live, not read from a row. */
export async function GET(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const relay = createRelay({ organizationId: principal.organizationId });
  if (!relay) {
    return NextResponse.json(
      {
        error: "NOT_CONNECTED",
        message:
          "No database is configured for this deployment, so no intents are stored. Set DATABASE_URL and run the migrations in packages/db.",
      },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const buyerAgentId = url.searchParams.get("buyerAgentId");
  const providerAgentId = url.searchParams.get("providerAgentId");

  const stored = await relay.list({
    ...(status ? { status: status.toUpperCase() as "OPEN" } : {}),
    ...(buyerAgentId ? { buyerAgentId } : {}),
    ...(providerAgentId ? { providerAgentId } : {}),
  });

  return NextResponse.json({
    intents: stored.map((entry) => ({
      intentId: entry.intent.intentId,
      hash: entry.hash,
      status: entry.status,
      signer: entry.signer,
      service: entry.intent.service,
      buyerAgentId: entry.intent.buyerAgentId,
      providerAgentId: entry.intent.providerAgentId,
      settlementAsset: entry.intent.settlementAsset,
      network: entry.intent.network,
      expiresAt: new Date(entry.intent.expiresAt * 1000).toISOString(),
      receivedAt: entry.receivedAt.toISOString(),
    })),
  });
}

const schema = z.object({
  buyerAgentId: z.string().min(1),
  providerAgentId: z.string().min(1),
  service: z.string().min(1).max(256),
  servicePayload: z.unknown().optional(),
  maxSpend: z.string(),
  minReceive: z.string().optional(),
  settlementAsset: z.enum(["USDC", "RLUSD", "EURC", "XRP"]).default("USDC"),
  allowedRails: z
    .array(
      z.enum([
        "X402",
        "CIRCLE_NANOPAYMENT",
        "ERC8183_ESCROW",
        "XRPL_PAYMENT",
        "XRPL_PATHFINDING",
        "XRPL_ESCROW",
        "MULEDGER",
      ]),
    )
    .min(1),
  network: z.enum(["ARC", "ARC_TESTNET", "XRPL", "XRPL_TESTNET", "MULEDGER"]).default("ARC"),
  destination: z.string().min(1).max(128),
  evaluator: z.string().min(1).max(256).default("evaluator.default.v1"),
  maxFxSlippageBps: z.number().int().min(0).max(10_000).default(0),
  maxNetworkFee: z.string().optional(),
  ttlSeconds: z.number().int().min(30).max(3600).default(300),
  deadlineSeconds: z.number().int().min(10).max(3600).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const verifyingContract = process.env.ARC_INTENT_VERIFIER_ADDRESS?.trim();
  if (!verifyingContract) {
    return NextResponse.json(
      {
        error: "CAPABILITY_UNAVAILABLE",
        message:
          "No intent verifier contract is configured (ARC_INTENT_VERIFIER_ADDRESS). An intent must be bound to a specific chain and contract, so none can be compiled until one is deployed.",
      },
      { status: 503 },
    );
  }

  const compiled = compileIntent(
    {
      buyerAgentId: parsed.data.buyerAgentId,
      providerAgentId: parsed.data.providerAgentId,
      service: parsed.data.service,
      servicePayload: parsed.data.servicePayload ?? { service: parsed.data.service },
      maxSpend: parsed.data.maxSpend,
      minReceive: parsed.data.minReceive ?? "0",
      settlementAsset: parsed.data.settlementAsset,
      allowedRails: parsed.data.allowedRails,
      network: parsed.data.network,
      destination: parsed.data.destination,
      evaluator: parsed.data.evaluator,
      chainId: Number(process.env.ARC_CHAIN_ID ?? 5042),
      verifyingContract,
      maxFxSlippageBps: parsed.data.maxFxSlippageBps,
      maxNetworkFee: parsed.data.maxNetworkFee ?? "0",
      ttlSeconds: parsed.data.ttlSeconds,
      ...(parsed.data.deadlineSeconds ? { deadlineSeconds: parsed.data.deadlineSeconds } : {}),
    },
    new Date(),
  );

  if (!compiled.ok) return violations(compiled.violations);

  const intent = compiled.value;
  const typedData = buildIntentTypedData(intent, keccak256);
  if (!typedData.ok) return violations(typedData.violations);
  const digest = hashIntent(intent, keccak256);
  if (!digest.ok) return violations(digest.violations);

  // Compiling deliberately stores nothing.
  //
  // An intent nobody has signed is not an authorization, and writing one into
  // the relay's store as OPEN made the relay's idempotency check short-circuit
  // every later submission to "already accepted" — before the signature,
  // ownership, nonce and mandate checks ran. The intent id is derived from the
  // content, so the document can be recompiled or simply signed and submitted.

  await recordAudit({
    organizationId: principal.organizationId,
    actor: `${principal.kind}:${principal.id}`,
    action: "intent.compiled",
    subject: intent.intentId,
    outcome: "ALLOW",
    detail: { service: intent.service, maxSpend: intent.maxSpend.toString() },
  });

  return NextResponse.json({
    intentId: intent.intentId,
    intentHash: intentHash(intent),
    digest: digest.value,
    // The canonical document to sign and hand back to /intents/submit.
    intent: intentToWire(intent),
    display: describeIntent(intent),
    typedData: {
      domain: typedData.value.domain,
      types: typedData.value.types,
      primaryType: typedData.value.primaryType,
      // bigints are serialized as decimal strings; a wallet reads them back as
      // uint256 values, and JSON cannot carry a bigint.
      message: Object.fromEntries(
        Object.entries(typedData.value.message).map(([key, value]) => [
          key,
          typeof value === "bigint" ? value.toString(10) : value,
        ]),
      ),
    },
    status: "AWAITING_SIGNATURE",
    persisted: false,
  });
}
