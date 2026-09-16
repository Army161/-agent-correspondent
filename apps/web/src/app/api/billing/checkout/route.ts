/**
 * Start a checkout.
 *
 * The transaction is created server-side so that `custom_data.organizationId`
 * is ours. If the browser supplied it, an attacker could have their own payment
 * credit an organization they do not own — or buy a subscription for someone
 * else and then dispute the charge.
 *
 * The response is a transaction id, which is what Paddle.js opens a checkout
 * for. It grants nothing: the plan is granted by the signed webhook, after
 * money has actually moved.
 */

import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { createTransaction } from "@/lib/billing/paddle";
import { billingConfigured, planById } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  if (!billingConfigured()) {
    return NextResponse.json(
      {
        error:
          "Billing is not configured on this deployment. PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET must both be set.",
      },
      { status: 503 },
    );
  }

  let body: { planId?: unknown; period?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "malformed body" }, { status: 400 });
  }

  const plan = typeof body.planId === "string" ? planById(body.planId) : undefined;
  if (!plan) return NextResponse.json({ error: "unknown plan" }, { status: 400 });

  const period = body.period === "yearly" ? "yearly" : "monthly";
  const priceId = period === "yearly" ? plan.priceIds.yearly : plan.priceIds.monthly;
  if (!priceId) {
    return NextResponse.json(
      {
        error: `No price is configured for the ${plan.name} plan billed ${period} on this deployment.`,
      },
      { status: 503 },
    );
  }

  const created = await createTransaction({
    priceId,
    organizationId: user.organizationId,
    customerEmail: user.email,
  });

  if (!created.ok) {
    console.error(`[billing] could not create transaction: ${created.error}`);
    return NextResponse.json({ error: "could not start checkout" }, { status: 502 });
  }

  return NextResponse.json({ transactionId: created.value.id, planId: plan.id, period });
}
