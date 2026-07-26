import type { ReactNode } from "react";
import { Field, FieldLabel } from "@/components/ui/field";

export function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Field className="gap-1.5">
      <FieldLabel className="w-full flex-col items-stretch gap-1.5 text-xs text-muted-foreground">
        <span>{label}</span>
        {children}
      </FieldLabel>
    </Field>
  );
}
