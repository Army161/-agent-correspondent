/**
 * The issuing key, published.
 *
 * A verifier needs three things: the document, the signature, and this. Serving
 * it openly is what makes verification offline — nobody has to ask us whether a
 * credential is good, which means our being down cannot turn every credential
 * invalid, or, worse, valid.
 */

import { NextResponse } from "next/server";

import { issuerState } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const state = issuerState();
  if (!state.configured) {
    return NextResponse.json(
      {
        configured: false,
        message:
          "This deployment has no credential issuing key, so it issues nothing and there is no key to publish.",
        requires: state.requires,
      },
      { status: 503 },
    );
  }
  return NextResponse.json(
    {
      configured: true,
      issuer: state.issuer,
      algorithm: "Ed25519",
      publicKey: state.publicKey,
      statusListUri: state.statusListUri,
      // See docs/POST_QUANTUM_READINESS.md. Additive only: a credential with
      // no secondary attestation is exactly as valid as one that predates
      // this field's existence, and this is never a claim that Ed25519
      // itself has been made "quantum-safe".
      secondaryAttestation: state.secondaryAttestationConfigured
        ? { algorithm: "ML-DSA-65", standard: "FIPS 204", publicKey: state.secondaryPublicKey }
        : null,
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
