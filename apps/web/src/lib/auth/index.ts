/**
 * Authentication, from the application's point of view.
 *
 * Identity is Better Auth's (`./server`); organization membership is ours
 * (`./session`). This module is the seam the rest of the app imports, so a
 * change of identity provider does not ripple through every page.
 *
 * There is no "demo mode" that signs you in without a database: without
 * Postgres, authentication reports that it is unavailable.
 */

export {
  authUnavailableReason,
  getAuth,
  socialProviderAvailability,
  type AuthInstance,
  type ProviderAvailability,
} from "./server";

export {
  currentUser,
  requireFreshSession,
  STEP_UP_WINDOW_SECONDS,
  type SessionUser,
} from "./session";
