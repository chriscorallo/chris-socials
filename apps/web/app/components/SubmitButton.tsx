"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * A form's submit button that shows it's working. Many actions here run model calls or
 * ffmpeg for tens of seconds — without feedback, a tap on a phone looks like nothing
 * happened and invites a second tap. Disabled while pending, so it can't double-submit.
 */
export function SubmitButton({
  children,
  className,
  disabled,
  pendingLabel = "Working…",
  name,
  value,
}: {
  children: ReactNode;
  className: string;
  disabled?: boolean;
  pendingLabel?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} aria-busy={pending || undefined} className={className} name={name} value={value}>
      {pending ? (
        <>
          <span className="spinner" aria-hidden />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
