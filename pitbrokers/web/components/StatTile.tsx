import type { ReactNode } from "react";

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "neon" | "down";
}) {
  const valueTone =
    tone === "neon" ? "text-neon" : tone === "down" ? "text-down" : "text-bone";

  return (
    <div className="panel p-4">
      <p className="font-display text-[10px] uppercase tracking-wider text-muted">
        {label}
      </p>
      <p className={`mt-2 font-display text-lg sm:text-xl ${valueTone}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function StatSkeleton({ label }: { label: string }) {
  return (
    <div className="panel p-4">
      <p className="font-display text-[10px] uppercase tracking-wider text-muted">
        {label}
      </p>
      <div className="mt-3 h-5 w-24 animate-pulse bg-edge" />
    </div>
  );
}
