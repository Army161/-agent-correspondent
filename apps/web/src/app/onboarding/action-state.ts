/**
 * The shape a `useActionState` form gets back.
 *
 * Kept out of `actions.ts`: a `"use server"` module may export async functions
 * and nothing else, so a shared constant has to live next door.
 */
export interface ActionState {
  readonly error: string | null;
  readonly ok: boolean;
}

export const IDLE: ActionState = { error: null, ok: false };
