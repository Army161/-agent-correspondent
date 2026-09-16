import type { Metadata } from "next";

import { AuthShell } from "@/components/auth/shell";
import { ResetPasswordForm } from "@/components/auth/password-reset-forms";

export const metadata: Metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}): Promise<React.JSX.Element> {
  const { token } = await searchParams;
  return (
    <AuthShell
      title="Choose a new password"
      description="This link works once. Choosing a new password signs out every other session on the account."
    >
      <ResetPasswordForm token={token?.trim() || null} />
    </AuthShell>
  );
}
