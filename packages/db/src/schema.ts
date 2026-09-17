/**
 * Agent Correspondent database schema.
 *
 * Conventions that hold throughout:
 *
 *  - Money is `numeric(38, 0)` holding *nanodollars* as an integer string.
 *    Never `float`, never `money`, never a decimal the driver might coerce.
 *    The application layer converts to `bigint` on read and back on write.
 *  - Financial and event tables are append-only. `economic_receipts`,
 *    `muledger_entries`, `reputation_events`, `job_events` and `audit_logs`
 *    have no UPDATE path in application code, and a database trigger (see
 *    `migrations/0001_append_only.sql`) rejects UPDATE and DELETE on them.
 *  - Every table that can be reached by an API key carries an `organization_id`
 *    so row-level scoping is always possible.
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Nanodollar column: an exact integer, stored as numeric to survive any driver.
 *
 * Used only where a value genuinely *is* US dollars — mandate limits, and USD
 * valuations of asset-native amounts. It is never used to hold a quantity of a
 * non-USD asset.
 */
const nanos = (name: string) => numeric(name, { precision: 38, scale: 0 });

/**
 * Atomic-unit column: an integer count of an asset's smallest unit.
 *
 * 78 digits because a uint256 needs 78. Always written alongside its asset id
 * and decimal scale — an atomic quantity without its scale is meaningless, and
 * a quantity without its asset is how one XRP becomes one dollar.
 */
const atomic = (name: string) => numeric(name, { precision: 78, scale: 0 });

/** Canonical asset id, e.g. `ARC:USDC` or `XRPL:RLUSD:rIssuer...`. */
const assetId = (name: string) => varchar(name, { length: 128 });

const id = (name = "id") => varchar(name, { length: 128 });

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const agentStatusEnum = pgEnum("agent_status", ["ACTIVE", "PAUSED", "DISABLED"]);
export const jobStateEnum = pgEnum("job_state", [
  "DRAFT",
  "QUOTED",
  "FUNDED",
  "IN_PROGRESS",
  "SUBMITTED",
  "EVALUATING",
  "COMPLETE",
  "REJECTED",
  "DISPUTED",
  "SETTLED",
  "CANCELLED",
]);
export const intentStatusEnum = pgEnum("intent_status", [
  "OPEN",
  "CONSUMED",
  "CANCELLED",
  "EXPIRED",
]);
export const ledgerStateEnum = pgEnum("ledger_state", ["OPEN", "NETTED", "SETTLED", "VOID"]);
export const settlementStatusEnum = pgEnum("settlement_status", [
  "PENDING",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED",
]);
export const evaluationResultEnum = pgEnum("evaluation_result", [
  "PASS",
  "FAIL",
  "NOT_EVALUATED",
  "DISPUTED",
]);
export const capabilityStateEnum = pgEnum("capability_state", [
  "AVAILABLE",
  "DISABLED",
  "TESTNET_ONLY",
  "EXPERIMENTAL",
  "UNKNOWN",
]);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: id().primaryKey(),
  name: text("name").notNull(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    displayName: text("display_name"),
    /**
     * The Better Auth identity this membership belongs to.
     *
     * Authentication lives in `auth_users`; this table is organization
     * membership. Nullable only so rows created before the migration remain
     * readable.
     */
    authUserId: text("auth_user_id").references(() => authUsers.id, { onDelete: "cascade" }),
    /** @deprecated Superseded by Better Auth credential accounts. */
    passwordHash: text("password_hash"),
    role: varchar("role", { length: 32 }).notNull().default("owner"),
    createdAt: createdAt(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id().primaryKey(),
    userId: id("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the session token. The token itself is never stored. */
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);


// ---------------------------------------------------------------------------
// Authentication (Better Auth)
// ---------------------------------------------------------------------------
//
// These tables are owned by Better Auth. They are declared here rather than
// generated into a separate file so that one migration history covers the whole
// database — an auth schema that drifts from the application schema is a class
// of outage nobody needs.
//
// The application's own `users` table remains for organization membership and
// is keyed to `auth_users.id`.

export const authUsers = pgTable(
  "auth_users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    /** Set by the twoFactor plugin once a second factor is enrolled. */
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("auth_users_email_unique").on(table.email)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    /** Opaque bearer token. Treated as a secret; never logged. */
    token: text("token").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Set by the twoFactor plugin while a second factor is outstanding. */
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_unique").on(table.token),
    index("auth_sessions_user_idx").on(table.userId),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    /** The provider's own identifier for this identity. */
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    /** Password hash for the credential provider. Never a reversible value. */
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_accounts_provider_unique").on(table.providerId, table.accountId),
    index("auth_accounts_user_idx").on(table.userId),
  ],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("auth_verifications_identifier_idx").on(table.identifier)],
);

export const authTwoFactors = pgTable(
  "auth_two_factors",
  {
    id: text("id").primaryKey(),
    /** TOTP secret. Encrypted at rest by Better Auth using AUTH_SECRET. */
    secret: text("secret").notNull(),
    /** Recovery codes, hashed. Shown once at generation and never again. */
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    /** False until the first correct code proves the secret was actually enrolled. */
    verified: boolean("verified").default(true),
    /**
     * Consecutive wrong codes. A six-digit code has a million values and a
     * thirty-second window; without a counter, that is brute-forceable.
     */
    failedVerificationCount: integer("failed_verification_count").default(0),
    /** Set when the counter trips. Verification is refused until it passes. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
  },
  (table) => [index("auth_two_factors_user_idx").on(table.userId)],
);

/**
 * Rate-limit counters.
 *
 * In the database rather than in process memory on purpose: a memory counter is
 * per-instance, so behind more than one server it limits nothing — an attacker
 * simply spreads the attempts. This table is shared state, which is what a
 * limit needs to be.
 */
export const authRateLimits = pgTable("auth_rate_limits", {
  id: text("id").primaryKey(),
  /** The limiter's own key: a path and an IP, never a user identifier. */
  key: text("key").notNull().unique(),
  count: integer("count").notNull().default(0),
  /** Epoch milliseconds of the most recent request in the window. */
  lastRequest: numeric("last_request", { precision: 20, scale: 0 }).notNull(),
});

export const authPasskeys = pgTable(
  "auth_passkeys",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    /** COSE public key. Public by construction; no secret is stored. */
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    credentialID: text("credential_i_d").notNull(),
    counter: integer("counter").notNull().default(0),
    deviceType: text("device_type"),
    backedUp: boolean("backed_up"),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
  },
  (table) => [index("auth_passkeys_user_idx").on(table.userId)],
);

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/**
 * Recorded onboarding answers.
 *
 * Deliberately small: it holds only what cannot be observed elsewhere. Whether
 * an agent exists is answered by the `agents` table, whether the address is
 * confirmed by `auth_users`, and whether the organization is named by
 * `organizations`. Duplicating those here would create a second, staler truth.
 */
export const onboardingProgress = pgTable(
  "onboarding_progress",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** One sentence on what they are building. Free text, never parsed for authorization. */
    purpose: text("purpose"),
    purposeRecordedAt: timestamp("purpose_recorded_at", { withTimezone: true, mode: "date" }),
    /** The plan the owner explicitly chose, including the free tier. */
    selectedPlanId: varchar("selected_plan_id", { length: 32 }),
    planSelectedAt: timestamp("plan_selected_at", { withTimezone: true, mode: "date" }),
    /** Set when the owner dismisses the checklist without finishing it. */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("onboarding_progress_org_unique").on(table.organizationId)],
);

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "NONE",
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "PAUSED",
  "CANCELED",
]);

/**
 * The billing state of one organization.
 *
 * Written only by the verified webhook handler and by a server-side
 * reconciliation read against the provider's API. Never written from a checkout
 * success callback: the browser reaching a success page proves the browser
 * reached a success page, and nothing about whether money moved.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `paddle`. Named so a second provider does not require a migration. */
    provider: varchar("provider", { length: 32 }).notNull(),
    providerCustomerId: varchar("provider_customer_id", { length: 128 }),
    providerSubscriptionId: varchar("provider_subscription_id", { length: 128 }),
    /** The provider price id this subscription is on, as configured. */
    providerPriceId: varchar("provider_price_id", { length: 128 }),
    /** Resolved from the price id through configuration, never from the browser. */
    planId: varchar("plan_id", { length: 32 }).notNull(),
    status: subscriptionStatusEnum("status").notNull().default("NONE"),
    /** The provider's own status string, kept verbatim for support and audit. */
    providerStatus: varchar("provider_status", { length: 64 }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "date" }),
    cancelAt: timestamp("cancel_at", { withTimezone: true, mode: "date" }),
    /** The provider event that last advanced this row, for idempotency and audit. */
    lastEventId: varchar("last_event_id", { length: 128 }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("subscriptions_org_unique").on(table.organizationId),
    index("subscriptions_provider_sub_idx").on(table.providerSubscriptionId),
  ],
);

/**
 * Every billing webhook that passed signature verification.
 *
 * Append-only and unique on the provider's event id: a replayed delivery is
 * recognised and ignored rather than applied twice. An unverified delivery
 * never reaches this table.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: id().primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    organizationId: id("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
    payload: jsonb("payload").notNull(),
    /** Null while the event is recorded but not yet applied. */
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }),
    /** Why the event was not applied, when it was not. */
    rejectedReason: text("rejected_reason"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("billing_events_provider_event_unique").on(table.provider, table.providerEventId),
    index("billing_events_org_idx").on(table.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const agents = pgTable(
  "agents",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: id("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    /** `openai`, `anthropic`, `local`, ... */
    provider: varchar("provider", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    systemPrompt: text("system_prompt"),
    status: agentStatusEnum("status").notNull().default("ACTIVE"),
    /** ERC-8004 agent id once the identity is registered on-chain. */
    erc8004AgentId: varchar("erc8004_agent_id", { length: 128 }),
    identityUri: text("identity_uri"),
    /** Tool ids this agent may call. Empty means no tools. */
    allowedTools: jsonb("allowed_tools").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("agents_org_idx").on(table.organizationId)],
);

export const agentCapabilities = pgTable(
  "agent_capabilities",
  {
    id: id().primaryKey(),
    agentId: id("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    capabilityId: varchar("capability_id", { length: 128 }).notNull(),
    category: varchar("category", { length: 64 }).notNull(),
    /** @deprecated USD nanodollars. Superseded by the asset-native columns below. */
    priceNanos: nanos("price_nanos").notNull(),
    /** Price per unit, in the asset it is actually quoted in. */
    priceAtomic: atomic("price_atomic"),
    priceAssetId: assetId("price_asset_id"),
    priceDecimals: integer("price_decimals"),
    unit: varchar("unit", { length: 32 }).notNull().default("call"),
    latencyMs: integer("latency_ms").notNull().default(0),
    validationSupported: boolean("validation_supported").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("agent_capability_unique").on(table.agentId, table.capabilityId)],
);

export const agentWallets = pgTable(
  "agent_wallets",
  {
    id: id().primaryKey(),
    agentId: id("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    network: varchar("network", { length: 32 }).notNull(),
    address: varchar("address", { length: 128 }).notNull(),
    /**
     * Where the signing key lives: `circle` (custodial API), `external`
     * (user-controlled), `readonly`. No column here ever holds key material —
     * see docs/SECURITY.md.
     */
    custody: varchar("custody", { length: 32 }).notNull(),
    /** Opaque reference into the custody provider, e.g. a Circle wallet id. */
    externalRef: varchar("external_ref", { length: 128 }),
    isPrimary: boolean("is_primary").notNull().default(false),
    /**
     * When control of this address was proved, and by which challenge.
     *
     * Null means the binding is a claim, not a fact. An unverified wallet is
     * never a signer and never a payout destination — an address typed into a
     * form proves nothing about who holds the key.
     */
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    /** The challenge that was answered. Evidence, retained for audit. */
    proofNonce: varchar("proof_nonce", { length: 64 }),
    /** The signature that answered it. Public by nature; no key material. */
    proofSignature: varchar("proof_signature", { length: 256 }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("agent_wallet_unique").on(table.agentId, table.network, table.address)],
);

/**
 * Outstanding proof-of-control challenges.
 *
 * Each row is a single-use nonce this service issued, bound to the agent, the
 * network and the address it was issued for. Consuming one is an atomic
 * conditional update, so the same proof cannot be replayed even by two requests
 * racing each other.
 */
export const walletChallenges = pgTable(
  "wallet_challenges",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: id("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    network: varchar("network", { length: 32 }).notNull(),
    address: varchar("address", { length: 128 }).notNull(),
    chainId: integer("chain_id").notNull(),
    nonce: varchar("nonce", { length: 64 }).notNull(),
    domain: varchar("domain", { length: 253 }).notNull(),
    statement: text("statement").notNull(),
    uri: text("uri").notNull(),
    resource: text("resource").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Set exactly once, by the request that successfully answers it. */
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("wallet_challenges_nonce_unique").on(table.nonce),
    index("wallet_challenges_agent_idx").on(table.agentId),
  ],
);

export const economicMandates = pgTable(
  "economic_mandates",
  {
    id: id().primaryKey(),
    agentId: id("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    dailySpendLimitNanos: nanos("daily_spend_limit_nanos").notNull(),
    maxTransactionNanos: nanos("max_transaction_nanos").notNull(),
    minimumReserveNanos: nanos("minimum_reserve_nanos").notNull(),
    unverifiedCounterpartyLimitNanos: nanos("unverified_counterparty_limit_nanos").notNull(),
    humanApprovalAboveNanos: nanos("human_approval_above_nanos").notNull(),
    creditAllowed: boolean("credit_allowed").notNull().default(false),
    tokenTradingAllowed: boolean("token_trading_allowed").notNull().default(false),
    allowedAssets: jsonb("allowed_assets").$type<string[]>().notNull(),
    allowedNetworks: jsonb("allowed_networks").$type<string[]>().notNull(),
    /** Monotonic; a new version is written rather than the old one edited. */
    version: integer("version").notNull().default(1),
    /** The user who authorized this version. A model can never be the author. */
    authorizedByUserId: id("authorized_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("mandate_agent_version_unique").on(table.agentId, table.version)],
);

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

export const economicIntents = pgTable(
  "economic_intents",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buyerAgentId: id("buyer_agent_id").notNull(),
    providerAgentId: id("provider_agent_id").notNull(),
    service: text("service").notNull(),
    serviceHash: varchar("service_hash", { length: 66 }).notNull(),
    /** @deprecated USD nanodollars. Superseded by the atomic columns below. */
    maxSpendNanos: nanos("max_spend_nanos").notNull(),
    minReceiveNanos: nanos("min_receive_nanos").notNull(),
    maxNetworkFeeNanos: nanos("max_network_fee_nanos").notNull(),
    /**
     * Authorized amounts in atomic units of `settlementAssetId`. These are the
     * numbers that were signed and the numbers a rail moves.
     */
    maxSpendAtomic: atomic("max_spend_atomic"),
    minReceiveAtomic: atomic("min_receive_atomic"),
    maxNetworkFeeAtomic: atomic("max_network_fee_atomic"),
    settlementAssetId: assetId("settlement_asset_id"),
    settlementAssetDecimals: integer("settlement_asset_decimals"),
    settlementAsset: varchar("settlement_asset", { length: 16 }).notNull(),
    allowedRails: jsonb("allowed_rails").$type<string[]>().notNull(),
    maxFxSlippageBps: integer("max_fx_slippage_bps").notNull().default(0),
    evaluator: varchar("evaluator", { length: 256 }).notNull(),
    network: varchar("network", { length: 32 }).notNull(),
    destination: varchar("destination", { length: 128 }).notNull(),
    chainId: integer("chain_id").notNull(),
    verifyingContract: varchar("verifying_contract", { length: 66 }).notNull(),
    nonce: varchar("nonce", { length: 66 }).notNull(),
    deadline: timestamp("deadline", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Canonical off-chain hash of the intent document. */
    intentHash: varchar("intent_hash", { length: 66 }).notNull(),
    status: intentStatusEnum("status").notNull().default("OPEN"),
    createdAt: createdAt(),
  },
  (table) => [
    index("intents_buyer_idx").on(table.buyerAgentId),
    index("intents_provider_idx").on(table.providerAgentId),
  ],
);

export const intentSignatures = pgTable(
  "intent_signatures",
  {
    id: id().primaryKey(),
    intentId: id("intent_id")
      .notNull()
      .references(() => economicIntents.id, { onDelete: "cascade" }),
    signer: varchar("signer", { length: 128 }).notNull(),
    signature: text("signature").notNull(),
    /** The EIP-712 digest that was actually signed. */
    digest: varchar("digest", { length: 66 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("intent_signature_unique").on(table.intentId, table.signer)],
);

/**
 * Burned nonces.
 *
 * The unique key is (signer, chain_id, verifying_contract, nonce): the same
 * nonce on another chain or another contract is a different reservation. This
 * table is what makes replay — including cross-chain replay — impossible rather
 * than merely unlikely, so rows are never deleted.
 */
export const intentNonces = pgTable(
  "intent_nonces",
  {
    signer: varchar("signer", { length: 128 }).notNull(),
    chainId: integer("chain_id").notNull(),
    verifyingContract: varchar("verifying_contract", { length: 66 }).notNull(),
    nonce: varchar("nonce", { length: 66 }).notNull(),
    intentId: id("intent_id"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.signer, table.chainId, table.verifyingContract, table.nonce],
    }),
  ],
);

export const quotes = pgTable(
  "quotes",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerAgentId: id("provider_agent_id").notNull(),
    capabilityId: varchar("capability_id", { length: 128 }).notNull(),
    /** @deprecated USD nanodollars. Superseded by the asset-native columns. */
    priceNanos: nanos("price_nanos").notNull(),
    effectiveCostNanos: nanos("effective_cost_nanos").notNull(),
    priceAtomic: atomic("price_atomic"),
    priceAssetId: assetId("price_asset_id"),
    priceDecimals: integer("price_decimals"),
    settlementAssetId: assetId("settlement_asset_id"),
    settlementAsset: varchar("settlement_asset", { length: 16 }).notNull(),
    latencyMs: integer("latency_ms").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("quotes_provider_idx").on(table.providerAgentId)],
);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buyerAgentId: id("buyer_agent_id").notNull(),
    providerAgentId: id("provider_agent_id"),
    intentId: id("intent_id").references(() => economicIntents.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    service: text("service").notNull(),
    requestPayload: jsonb("request_payload"),
    state: jobStateEnum("state").notNull().default("DRAFT"),
    escrowNanos: nanos("escrow_nanos"),
    settlementAsset: varchar("settlement_asset", { length: 16 }),
    network: varchar("network", { length: 32 }),
    /** ERC-8183 job id once the job exists on-chain. */
    onchainJobId: varchar("onchain_job_id", { length: 128 }),
    evaluator: varchar("evaluator", { length: 256 }),
    resultHash: varchar("result_hash", { length: 66 }),
    deliverableUri: text("deliverable_uri"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("jobs_org_idx").on(table.organizationId),
    index("jobs_state_idx").on(table.state),
  ],
);

/** Append-only. One row per state transition, with the actor that caused it. */
export const jobEvents = pgTable(
  "job_events",
  {
    id: id().primaryKey(),
    jobId: id("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    fromState: jobStateEnum("from_state"),
    toState: jobStateEnum("to_state").notNull(),
    transition: varchar("transition", { length: 48 }).notNull(),
    /** `user:<id>`, `agent:<id>`, or `system`. */
    actor: varchar("actor", { length: 128 }).notNull(),
    detail: jsonb("detail"),
    createdAt: createdAt(),
  },
  (table) => [index("job_events_job_idx").on(table.jobId)],
);

// ---------------------------------------------------------------------------
// Money movement
// ---------------------------------------------------------------------------

export const transactions = pgTable(
  "transactions",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: id("agent_id").references(() => agents.id, { onDelete: "set null" }),
    intentId: id("intent_id").references(() => economicIntents.id, { onDelete: "set null" }),
    direction: varchar("direction", { length: 8 }).notNull(),
    /** @deprecated USD nanodollars. Superseded by the asset-native columns. */
    amountNanos: nanos("amount_nanos").notNull(),
    feeNanos: nanos("fee_nanos").notNull().default("0"),
    /**
     * The amount and the fee, each in its own asset's atomic units. Written out
     * rather than generated: a helper spread here once produced two column sets
     * under the same JavaScript keys, and the second silently replaced the
     * first.
     */
    amountAtomic: atomic("amount_atomic"),
    amountAssetId: assetId("amount_asset_id"),
    amountDecimals: integer("amount_decimals"),
    feeAtomic: atomic("fee_atomic"),
    feeAssetId: assetId("fee_asset_id"),
    feeDecimals: integer("fee_decimals"),
    /** USD valuation of `amount`, with provenance. Null when it could not be valued. */
    amountUsdNanos: nanos("amount_usd_nanos"),
    amountUsdSource: varchar("amount_usd_source", { length: 128 }),
    amountUsdAsOf: timestamp("amount_usd_as_of", { withTimezone: true, mode: "date" }),
    asset: varchar("asset", { length: 16 }).notNull(),
    network: varchar("network", { length: 32 }).notNull(),
    rail: varchar("rail", { length: 48 }).notNull(),
    counterparty: varchar("counterparty", { length: 128 }),
    reference: varchar("reference", { length: 256 }),
    status: settlementStatusEnum("status").notNull().default("PENDING"),
    createdAt: createdAt(),
  },
  (table) => [
    index("transactions_org_idx").on(table.organizationId),
    // One settlement reference per network, ever: the duplicate-settlement guard.
    uniqueIndex("transactions_reference_unique").on(table.network, table.reference),
  ],
);

export const settlements = pgTable(
  "settlements",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cycleId: id("cycle_id"),
    intentId: id("intent_id").references(() => economicIntents.id, { onDelete: "set null" }),
    fromAgentId: id("from_agent_id").notNull(),
    toAgentId: id("to_agent_id").notNull(),
    /** @deprecated USD nanodollars. Superseded by the asset-native columns. */
    amountNanos: nanos("amount_nanos").notNull(),
    amountAtomic: atomic("amount_atomic"),
    amountAssetId: assetId("amount_asset_id"),
    amountDecimals: integer("amount_decimals"),
    asset: varchar("asset", { length: 16 }).notNull(),
    network: varchar("network", { length: 32 }).notNull(),
    rail: varchar("rail", { length: 48 }).notNull(),
    status: settlementStatusEnum("status").notNull().default("PENDING"),
    reference: varchar("reference", { length: 256 }),
    /** Idempotency key: retrying a settlement must not send twice. */
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    createdAt: createdAt(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [uniqueIndex("settlements_idempotency_unique").on(table.idempotencyKey)],
);

/** Append-only. The gross history that every clearing cycle is derived from. */
export const muledgerEntries = pgTable(
  "muledger_entries",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    debtorAgentId: id("debtor_agent_id").notNull(),
    creditorAgentId: id("creditor_agent_id").notNull(),
    /** @deprecated Superseded by the asset-native columns; identical for μLedger assets. */
    amountNanos: nanos("amount_nanos").notNull(),
    /**
     * The obligation, in atomic units of a μLedger accounting asset. μLedger
     * assets carry nanodollar precision deliberately: a 40-nanodollar
     * obligation is 0.04 of a single USDC unit and is not representable on the
     * rail until many of them have been netted together.
     */
    amountAtomic: atomic("amount_atomic"),
    amountAssetId: assetId("amount_asset_id"),
    amountDecimals: integer("amount_decimals"),
    asset: varchar("asset", { length: 16 }).notNull(),
    service: text("service").notNull(),
    intentId: id("intent_id"),
    receiptId: id("receipt_id"),
    state: ledgerStateEnum("state").notNull().default("OPEN"),
    cycleId: id("cycle_id"),
    /** One economic event, one entry. This is the double-credit defence. */
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("muledger_idempotency_unique").on(table.idempotencyKey),
    index("muledger_debtor_idx").on(table.debtorAgentId),
    index("muledger_creditor_idx").on(table.creditorAgentId),
    index("muledger_state_idx").on(table.state),
  ],
);

export const clearingCycles = pgTable(
  "clearing_cycles",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    asset: varchar("asset", { length: 16 }).notNull(),
    assetId: assetId("asset_id"),
    assetDecimals: integer("asset_decimals"),
    mode: varchar("mode", { length: 24 }).notNull(),
    /** @deprecated Superseded by the atomic columns. */
    grossTotalNanos: nanos("gross_total_nanos").notNull(),
    netTotalNanos: nanos("net_total_nanos").notNull(),
    grossTotalAtomic: atomic("gross_total_atomic"),
    netTotalAtomic: atomic("net_total_atomic"),
    entryCount: integer("entry_count").notNull(),
    instructionCount: integer("instruction_count").notNull(),
    /** Canonical hash over inputs and outputs; makes the cycle reproducible. */
    proofHash: varchar("proof_hash", { length: 66 }).notNull(),
    instructions: jsonb("instructions").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [index("clearing_org_idx").on(table.organizationId)],
);

/** Append-only, immutable. Reputation is derived from these rows. */
export const economicReceipts = pgTable(
  "economic_receipts",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buyerAgentId: id("buyer_agent_id").notNull(),
    providerAgentId: id("provider_agent_id").notNull(),
    intentId: id("intent_id"),
    jobId: id("job_id"),
    service: text("service").notNull(),
    /** @deprecated USD nanodollars. Superseded by the asset-native columns. */
    quotedPriceNanos: nanos("quoted_price_nanos").notNull(),
    finalPriceNanos: nanos("final_price_nanos").notNull(),
    quotedPriceAtomic: atomic("quoted_price_atomic"),
    quotedPriceAssetId: assetId("quoted_price_asset_id"),
    quotedPriceDecimals: integer("quoted_price_decimals"),
    finalPriceAtomic: atomic("final_price_atomic"),
    finalPriceAssetId: assetId("final_price_asset_id"),
    finalPriceDecimals: integer("final_price_decimals"),
    /** USD valuation of the final price, with provenance. */
    finalPriceUsdNanos: nanos("final_price_usd_nanos"),
    finalPriceUsdSource: varchar("final_price_usd_source", { length: 128 }),
    finalPriceUsdAsOf: timestamp("final_price_usd_as_of", { withTimezone: true, mode: "date" }),
    network: varchar("network", { length: 32 }).notNull(),
    settlementRail: varchar("settlement_rail", { length: 48 }).notNull(),
    settlementAsset: varchar("settlement_asset", { length: 16 }).notNull(),
    transactionReference: varchar("transaction_reference", { length: 256 }).notNull(),
    resultHash: varchar("result_hash", { length: 66 }).notNull(),
    evaluator: varchar("evaluator", { length: 256 }).notNull(),
    evaluationResult: evaluationResultEnum("evaluation_result").notNull(),
    reputationEffect: integer("reputation_effect").notNull().default(0),
    /** Canonical hash of the receipt document. Detects any later edit. */
    receiptHash: varchar("receipt_hash", { length: 66 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("receipts_settlement_unique").on(table.network, table.transactionReference),
    index("receipts_provider_idx").on(table.providerAgentId),
    index("receipts_buyer_idx").on(table.buyerAgentId),
  ],
);

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

/** Append-only. */
export const reputationEvents = pgTable(
  "reputation_events",
  {
    id: id().primaryKey(),
    agentId: id("agent_id").notNull(),
    counterpartyAgentId: id("counterparty_agent_id").notNull(),
    kind: varchar("kind", { length: 48 }).notNull(),
    /** Settled value in USD nanodollars, with the provenance of that valuation. */
    valueNanos: nanos("value_nanos").notNull().default("0"),
    valueUsdSource: varchar("value_usd_source", { length: 128 }),
    valueUsdAsOf: timestamp("value_usd_as_of", { withTimezone: true, mode: "date" }),
    receiptId: id("receipt_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("reputation_events_agent_idx").on(table.agentId)],
);

export const reputationSnapshots = pgTable(
  "reputation_snapshots",
  {
    id: id().primaryKey(),
    agentId: id("agent_id").notNull(),
    score: integer("score"),
    completedJobs: integer("completed_jobs").notNull().default(0),
    failedJobs: integer("failed_jobs").notNull().default(0),
    disputes: integer("disputes").notNull().default(0),
    settledValueNanos: nanos("settled_value_nanos").notNull().default("0"),
    distinctCounterparties: integer("distinct_counterparties").notNull().default(0),
    successRate: real("success_rate"),
    evidence: jsonb("evidence"),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("reputation_snapshots_agent_idx").on(table.agentId)],
);

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export const networkCapabilities = pgTable(
  "network_capabilities",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    state: capabilityStateEnum("state").notNull().default("UNKNOWN"),
    source: varchar("source", { length: 32 }).notNull().default("default"),
    note: text("note"),
    checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" }),
  },
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 of the key. The key itself is shown once, at creation, and never stored. */
    keyHash: varchar("key_hash", { length: 128 }).notNull(),
    prefix: varchar("prefix", { length: 16 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("api_keys_hash_unique").on(table.keyHash)],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** HMAC secret used to sign deliveries. */
    secretHash: varchar("secret_hash", { length: 128 }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [index("webhooks_org_idx").on(table.organizationId)],
);

/** Replay defence for inbound webhooks: a delivery id is accepted exactly once. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id().primaryKey(),
    source: varchar("source", { length: 64 }).notNull(),
    externalId: varchar("external_id", { length: 256 }).notNull(),
    receivedAt: createdAt(),
  },
  (table) => [uniqueIndex("webhook_delivery_unique").on(table.source, table.externalId)],
);

/** Append-only. Every economic decision, including the refusals. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id"),
    actor: varchar("actor", { length: 128 }).notNull(),
    action: varchar("action", { length: 96 }).notNull(),
    subject: varchar("subject", { length: 128 }),
    /** `ALLOW`, `DENY`, `REQUIRE_HUMAN_APPROVAL`, `ERROR`. */
    outcome: varchar("outcome", { length: 32 }).notNull(),
    detail: jsonb("detail"),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_logs_org_idx").on(table.organizationId),
    index("audit_logs_action_idx").on(table.action),
  ],
);

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: id("user_id").references(() => users.id, { onDelete: "set null" }),
    agentId: id("agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title").notNull().default("New conversation"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("chat_threads_org_idx").on(table.organizationId)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: id().primaryKey(),
    threadId: id("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content").notNull(),
    /** Tool/action cards rendered alongside the message. */
    parts: jsonb("parts"),
    createdAt: createdAt(),
  },
  (table) => [index("chat_messages_thread_idx").on(table.threadId)],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const organizationRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  agents: many(agents),
}));

export const agentRelations = relations(agents, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [agents.organizationId],
    references: [organizations.id],
  }),
  capabilities: many(agentCapabilities),
  wallets: many(agentWallets),
  mandates: many(economicMandates),
}));

export const jobRelations = relations(jobs, ({ many, one }) => ({
  events: many(jobEvents),
  intent: one(economicIntents, {
    fields: [jobs.intentId],
    references: [economicIntents.id],
  }),
}));
