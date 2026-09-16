import type { ReactNode } from "react";

import { EmptyState } from "@/components/ui/primitives";

export interface DataViewLike {
  readonly state: "READY" | "EMPTY" | "NOT_CONNECTED" | "ERROR";
  readonly reason?: string;
}

/**
 * Renders the honest non-ready states.
 *
 * A screen never falls through to a zero, a placeholder balance or a skeleton
 * that implies data is coming. It says which of the four states it is in and,
 * when something is misconfigured, exactly what to configure.
 */
export function DataState({
  view,
  emptyTitle,
  emptyDescription,
  action,
}: {
  view: DataViewLike;
  emptyTitle: string;
  emptyDescription?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element | null {
  switch (view.state) {
    case "READY":
      return null;
    case "EMPTY":
      return <EmptyState title={emptyTitle} description={emptyDescription} action={action} />;
    case "NOT_CONNECTED":
      return (
        <EmptyState
          title="NOT CONNECTED"
          description={
            view.reason ??
            "This deployment has no database configured, so there is nothing to display."
          }
          action={action}
        />
      );
    case "ERROR":
      return (
        <EmptyState
          title="AWAITING DATA"
          description={`The platform could not read this data: ${view.reason ?? "unknown error"}`}
          action={action}
        />
      );
  }
}
