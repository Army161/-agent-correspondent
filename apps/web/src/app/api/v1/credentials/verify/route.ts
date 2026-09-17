/**
 * Verify a credential.
 *
 * A convenience, not the mechanism. Anyone can do this themselves with the
 * document, the signature, the published issuer key and the revocation list —
 * and they should, because a verifier that depends on this endpoint has made
 * our availability part of their security model.
 *
 * Public and unauthenticated: the counterparty checking one of our credentials
 * is not one of our customers.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  credentialSigningBytes,
  verifyCredential,
  verifyMlDsa,
  type CredentialDocument,
} from "@acor/core";

import { badRequest, readJson } from "@/lib/api";
import { issuerState, revokedCredentialIds } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  document: z.record(z.string(), z.unknown()),
  signature: z.string().min(16).max(256),
  /** Optional: defaults to this deployment's published key. */
  issuerPublicKey: z.string().min(32).max(128).optional(),
  /**
   * Optional. See docs/POST_QUANTUM_READINESS.md. Checking it is purely
   * additive to the required primary check above; omitting it does not
   * change `valid`.
   */
  secondaryAttestation: z
    .object({ algorithm: z.literal("ml-dsa-65"), publicKey: z.string(), signature: z.string() })
    .optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const state = issuerState();
  const publicKey = parsed.data.issuerPublicKey ?? state.publicKey;
  if (!publicKey) {
    return NextResponse.json(
      {
        valid: false,
        reasons: [
          "no issuer key was supplied and this deployment publishes none, so nothing can be checked",
        ],
      },
      { status: 503 },
    );
  }

  const revoked = new Set(await revokedCredentialIds());
  const result = verifyCredential(
    parsed.data.document as unknown as CredentialDocument,
    parsed.data.signature,
    publicKey,
    new Date(),
    revoked,
  );

  const secondary = parsed.data.secondaryAttestation
    ? {
        algorithm: parsed.data.secondaryAttestation.algorithm,
        publicKey: parsed.data.secondaryAttestation.publicKey,
        valid: verifyMlDsa(
          credentialSigningBytes(parsed.data.document as unknown as CredentialDocument),
          parsed.data.secondaryAttestation.signature,
          parsed.data.secondaryAttestation.publicKey,
        ),
      }
    : null;

  return NextResponse.json({
    valid: result.valid,
    // Every reason at once: a holder fixing one problem should not discover
    // the next one on the following request.
    reasons: result.reasons,
    digest: result.digest,
    checkedAgainst: { issuerPublicKey: publicKey, revocationCount: revoked.size },
    // Reported separately from `valid` on purpose -- see the schema comment
    // above. Absent when no secondary attestation was supplied to check.
    secondaryAttestation: secondary,
  });
}
