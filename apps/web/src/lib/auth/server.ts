/**
 * Better Auth configuration.
 *
 * Replaces the hand-rolled session layer with an audited framework, while
 * keeping the properties the hand-rolled one had: scrypt-class password
 * hashing, opaque session tokens, httpOnly cookies, Postgres storage.
 *
 * Providers are enabled only when their credentials are present. A sign-in
 * button that cannot complete is worse than an absent one, so the UI reads this
 * configuration rather than assuming.
 */

import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { twoFactor } from "better-auth/plugins";

import { getDb, schema } from "@acor/db";

import {
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "../email";
import { SITE_URL } from "../env";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./policy";

export interface ProviderAvailability {
  readonly id: "google" | "github" | "apple";
  readonly label: string;
  readonly configured: boolean;
  readonly requires: readonly string[];
}

function present(...names: string[]): boolean {
  return names.every((name) => (process.env[name]?.trim().length ?? 0) > 0);
}

/**
 * Which social providers this deployment can actually complete a sign-in with.
 *
 * Rendered on the sign-in page so an unconfigured provider is shown as
 * unavailable rather than as a button that fails after the redirect.
 */
export function socialProviderAvailability(): readonly ProviderAvailability[] {
  return [
    {
      id: "google",
      label: "Google",
      configured: present("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
      requires: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    },
    {
      id: "github",
      label: "GitHub",
      configured: present("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
      requires: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    },
    {
      id: "apple",
      label: "Apple",
      configured: present("APPLE_CLIENT_ID", "APPLE_CLIENT_SECRET"),
      requires: ["APPLE_CLIENT_ID", "APPLE_CLIENT_SECRET"],
    },
  ];
}

/**
 * Trusted origins for OAuth redirects and cookie scope.
 *
 * An exact allowlist, never a wildcard: an open redirect in an auth flow hands
 * an attacker a valid session.
 */
function trustedOrigins(): string[] {
  const origins = new Set<string>([SITE_URL]);
  const extra = process.env.AUTH_TRUSTED_ORIGINS?.trim();
  if (extra) {
    for (const origin of extra.split(",")) {
      const trimmed = origin.trim();
      if (trimmed.length > 0) origins.add(trimmed);
    }
  }
  if (process.env.NODE_ENV !== "production") {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
    origins.add("http://127.0.0.1:3111");
  }
  return [...origins];
}

/**
 * A rate-limit threshold from the environment.
 *
 * Out-of-range and unparseable values fall back to the default rather than
 * disabling the limit: a typo in an environment variable must not silently
 * remove a control. Zero and negative numbers are not honoured at all.
 */
function rateLimit(name: string, fallbackMax: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackMax;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) return fallbackMax;
  return parsed;
}

type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * Send a security email, and make a delivery failure visible.
 *
 * Better Auth treats a throwing sender as a failed request, which would turn a
 * mail outage into a failed sign-up. The account is more valuable than the
 * notification, so the failure is logged and swallowed; the user is told to
 * request a new link, and the operator sees why none arrived.
 */
async function deliver(message: Parameters<typeof sendEmail>[0]): Promise<void> {
  const result = await sendEmail(message);
  if (!result.ok) {
    console.error(`[auth] ${message.kind} email was not delivered: ${result.error}`);
  }
}

/**
 * Build the auth instance.
 *
 * Kept as a named function so its *inferred* return type — which carries the
 * plugin endpoints as literal types — is what callers see. Widening it to
 * `Auth<BetterAuthOptions>` would erase `auth.api.enableTwoFactor` and friends.
 */
function buildAuth(db: Db, secret: string) {
  const social = socialProviderAvailability();
  const enabled = Object.fromEntries(
    social
      .filter((provider) => provider.configured)
      .map((provider) => [
        provider.id,
        {
          clientId: process.env[`${provider.id.toUpperCase()}_CLIENT_ID`] as string,
          clientSecret: process.env[`${provider.id.toUpperCase()}_CLIENT_SECRET`] as string,
        },
      ]),
  );

  return betterAuth({
    secret,
    baseURL: process.env.AUTH_BASE_URL?.trim() || SITE_URL,
    trustedOrigins: trustedOrigins(),

    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.authUsers,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
        twoFactor: schema.authTwoFactors,
        passkey: schema.authPasskeys,
        rateLimit: schema.authRateLimits,
      },
    }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // Verification is required before an account can do anything economic —
      // that gate lives in the onboarding state machine. It is not required to
      // *create* the account, so a user can see the product before committing
      // to an inbox round trip.
      requireEmailVerification: false,
      autoSignIn: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      async sendResetPassword({ user, url }) {
        await deliver(passwordResetEmail(user.email, url));
      },
      async onPasswordReset({ user }) {
        // Changing a password invalidates every other session: a reset is the
        // remedy for a compromise, and it has to actually evict the attacker.
        // (Better Auth revokes sessions itself; this records the event.)
        console.info(`[auth] password reset completed for user ${user.id}`);
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      async sendVerificationEmail({ user, url }) {
        await deliver(verificationEmail(user.email, url));
      },
    },

    socialProviders: enabled,

    account: {
      accountLinking: {
        // Never link an OAuth identity to an existing account by email alone.
        // An attacker who controls an unverified address at a provider could
        // otherwise take over an account by signing in with it.
        enabled: true,
        trustedProviders: [],
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 10,
    },

    /**
     * Rate limiting.
     *
     * The counters live in Postgres, not in process memory: a per-process
     * counter limits nothing behind more than one instance, because the
     * attempts simply spread out. The credential endpoints get their own,
     * much tighter rules — a global limit generous enough for normal browsing
     * is far too generous for password guessing.
     *
     * The thresholds are configuration because the right number depends on
     * where the deployment sits: behind a shared egress IP, a NAT, or a test
     * harness, everyone looks like one client. Limiting cannot be switched
     * off, only tuned.
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: rateLimit("AUTH_RATE_LIMIT_MAX", 100),
      storage: "database",
      modelName: "rateLimit",
      customRules: {
        "/sign-in/email": { window: 60, max: rateLimit("AUTH_RATE_LIMIT_SIGN_IN", 5) },
        "/sign-up/email": { window: 60, max: rateLimit("AUTH_RATE_LIMIT_SIGN_UP", 5) },
        "/request-password-reset": { window: 60, max: rateLimit("AUTH_RATE_LIMIT_RESET", 3) },
        "/reset-password": { window: 60, max: rateLimit("AUTH_RATE_LIMIT_RESET", 3) },
        "/send-verification-email": { window: 60, max: rateLimit("AUTH_RATE_LIMIT_RESET", 3) },
        "/two-factor/verify-totp": { window: 60, max: rateLimit("AUTH_RATE_LIMIT_SIGN_IN", 5) },
        "/two-factor/verify-backup-code": {
          window: 60,
          max: rateLimit("AUTH_RATE_LIMIT_SIGN_IN", 5),
        },
      },
    },

    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
      cookiePrefix: "acor",
    },

    plugins: [
      twoFactor({
        issuer: "Agent Correspondent",
      }),
      passkey({
        rpName: "Agent Correspondent",
        rpID: process.env.AUTH_RP_ID?.trim() || new URL(SITE_URL).hostname,
        origin: process.env.AUTH_BASE_URL?.trim() || SITE_URL,
      }),
      nextCookies(),
    ],
  });
}

export type AuthInstance = ReturnType<typeof buildAuth>;

let instance: AuthInstance | null = null;

/**
 * The auth instance, or `null` when this deployment has no database.
 *
 * Returning null rather than throwing keeps the "not connected" path honest:
 * the sign-in page explains what is missing instead of rendering a 500.
 */
export function getAuth(): AuthInstance | null {
  if (instance) return instance;

  const db = getDb();
  if (!db) return null;

  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 16) return null;

  instance = buildAuth(db, secret);
  return instance;
}

/** Why authentication is unavailable, when it is. */
export function authUnavailableReason(): string | null {
  if (!getDb()) {
    return "No database is configured. Set DATABASE_URL and run the migrations in packages/db.";
  }
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return "AUTH_SECRET is not set, or is shorter than 16 characters.";
  }
  return null;
}
