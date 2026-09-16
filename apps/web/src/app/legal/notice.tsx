/**
 * The pre-launch banner.
 *
 * These documents describe what the software in this repository actually does
 * with data — they are accurate, and they are not a substitute for reviewed
 * contract terms. Saying so plainly is better than publishing boilerplate that
 * claims a review nobody performed.
 */
export function PreLaunchNotice(): React.JSX.Element {
  return (
    <div className="mb-8 rounded-lg border border-[rgba(255,176,32,0.3)] bg-[rgba(255,176,32,0.05)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-warning)]">
      <strong className="font-semibold">Pre-launch draft.</strong> This document describes how the
      software behaves today. It has not been reviewed by counsel and is not yet the binding
      agreement for a paid service. It will be replaced before any account is charged.
    </div>
  );
}
