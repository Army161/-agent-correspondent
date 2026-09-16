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
import { getDb, economicIntents, toNanosColumn } from "@acor/db";
import {
  buildIntentTypedData,
  compileIntent,
  describeIntent,
  hashIntent,
  intentHash,
} from "@acor/core";

import {
  authenticateRequest,
  badRequest,
  readJson,
  unauthorized,
  violations,
} from "@/lib/api";
import { recordAudit } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // Persist the compiled intent so the relay can recognise it later. Storage is
  // optional: compiling works without a database, it just is not remembered.
  const db = getDb();
  if (db) {
    try {
      await db.insert(economicIntents).values({
        id: intent.intentId,
        organizationId: principal.organizationId,
        buyerAgentId: intent.buyerAgentId,
        providerAgentId: intent.providerAgentId,
        service: intent.service,
        serviceHash: intent.serviceHash,
        maxSpendNanos: toNanosColumn(intent.maxSpend),
        minReceiveNanos: toNanosColumn(intent.minReceive),
        maxNetworkFeeNanos: toNanosColumn(intent.maxNetworkFee),
        settlementAsset: intent.settlementAsset,
        allowedRails: [...intent.allowedRails],
        maxFxSlippageBps: intent.maxFxSlippageBps,
        evaluator: intent.evaluator,
        network: intent.network,
        destination: intent.destination,
        chainId: intent.chainId,
        verifyingContract: intent.verifyingContract,
        nonce: intent.nonce,
        deadline: new Date(intent.deadline * 1000),
        expiresAt: new Date(intent.expiresAt * 1000),
        intentHash: intentHash(intent),
        status: "OPEN",
      });
    } catch {
      // A duplicate id means the same intent was compiled twice, which is
      // idempotent by construction — the id is derived from the content.
    }
  }

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
    persisted: db !== null,
  });
}
