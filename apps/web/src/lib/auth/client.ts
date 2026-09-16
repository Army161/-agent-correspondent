/**
 * The browser-side auth client.
 *
 * Deliberately separate from `./server`: that module is `server-only` and
 * carries secrets, this one runs in the user's browser and carries none. The
 * two share only the wire protocol.
 *
 * Nothing here is an authorization decision. A successful call means the server
 * said yes; the browser never decides that for itself, and a page that renders
 * on the strength of a client-side check still gets re-checked server-side.
 */

"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  plugins: [twoFactorClient(), passkeyClient()],
});

export const { signIn, signOut, signUp, useSession } = authClient;

/**
 * Turn whatever an auth call rejected with into something worth showing.
 *
 * Better Auth returns structured errors; anything else (a network failure, a
 * proxy error page) must not be echoed verbatim into the UI.
 */
export function authErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
    const statusText = (error as { statusText?: unknown }).statusText;
    if (typeof statusText === "string" && statusText.trim().length > 0) return statusText;
  }
  return fallback;
}
