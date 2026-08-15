"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Confirmation for irreversible actions.
 *
 * The sell-back dialog must state the exact amount and that it cannot be undone,
 * so the amount is a required prop rather than something a call site can forget.
 */
export function ConfirmDialog({
  open,
  title,
  amountLine,
  body,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** Exact amount, already formatted. Shown prominently. */
  amountLine: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/80 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div className="panel-neon w-full max-w-md p-5">
        <h2 id="confirm-title" className="font-display text-sm text-neon">
          {title}
        </h2>

        <p className="mt-4 font-display text-lg text-bone">{amountLine}</p>

        {body && <div className="mt-3 text-sm text-muted">{body}</div>}

        <p className="mt-4 border-2 border-down bg-down/10 p-3 text-xs text-bone">
          This is irreversible. Once confirmed it cannot be undone.
        </p>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            className="btn-ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Confirming…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
