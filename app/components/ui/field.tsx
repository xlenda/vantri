import type { ComponentProps, ReactNode } from "react";

// text-base (16 px) no celular: abaixo disso o iOS dá zoom ao focar o campo.
export const inputClass =
  "block h-11 w-full rounded-xl border border-line bg-white px-3.5 text-base text-ink transition-colors placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15 sm:text-[15px]";

/** Rótulo + controle + dica. `htmlFor` liga o rótulo ao controle; a dica vira aria-describedby. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${htmlFor}-dica`} className="mt-1.5 text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

type Labeled = { label: ReactNode; hint?: ReactNode; name: string };

export function Input({ label, hint, name, id = name, className = "", ...props }: ComponentProps<"input"> & Labeled) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <input
        id={id}
        name={name}
        aria-describedby={hint ? `${id}-dica` : undefined}
        className={`${inputClass} ${className}`}
        {...props}
      />
    </Field>
  );
}

export function Select({ label, hint, name, id = name, className = "", ...props }: ComponentProps<"select"> & Labeled) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="relative">
        <select
          id={id}
          name={name}
          aria-describedby={hint ? `${id}-dica` : undefined}
          className={`${inputClass} appearance-none pr-10 ${className}`}
          {...props}
        />
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5.5 7.5l4.5 4.5 4.5-4.5" />
        </svg>
      </div>
    </Field>
  );
}
