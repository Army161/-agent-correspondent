import type { Metadata } from "next";

import { AuthShell } from "@/components/auth/shell";
import { ForgotPasswordForm } from "@/components/auth/password-reset-forms";
import { authUnavailableReason } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";

export const metadata: Metadata = { title: "Reset your password" };
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage(): Promise<React.JSX.Element> {
  const authReason = authUnavailableReason();
  const mail = emailConfigured();

  const description = authReason
    ? `Password reset is unavailable on this deployment. ${authReason}`
    : mail
      ? "Enter the address on the account. We will send a single-use link that expires in one hour."
      : "No email provider is configured on this deployment, so a reset link cannot be delivered. Set RESEND_API_KEY and EMAIL_FROM.";

  return (
    <AuthShell title="Reset your password" description={description}>
      <ForgotPasswordForm disabled={authReason !== null || !mail} />
    </AuthShell>
  );
}
