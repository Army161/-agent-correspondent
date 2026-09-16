import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Sign up" };

/**
 * `/signup` is the public-facing name for account creation.
 *
 * The form itself lives at `/login?mode=register` so there is exactly one place
 * that renders the credential fields, the OAuth buttons and the terms
 * acknowledgement — two copies of an auth form is two places to get it wrong.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}): Promise<never> {
  const { plan } = await searchParams;
  redirect(plan ? `/login?mode=register&plan=${encodeURIComponent(plan)}` : "/login?mode=register");
}
