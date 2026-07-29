import { cn } from "../lib/utils";

export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src="/kloud-logo.svg"
      width={1024}
      height={1024}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("block shrink-0", className)}
    />
  );
}
