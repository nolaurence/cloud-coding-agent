import { cn } from "../lib/utils";

export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src="/kloud-logo.svg"
      alt=""
      aria-hidden="true"
      className={cn("shrink-0", className)}
    />
  );
}
