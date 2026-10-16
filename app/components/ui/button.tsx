import type { ComponentProps } from "react";

// Por cima das classes .btn* do globals.css: um só sistema de botão.
const VARIANTS = { primary: "btn-primary", ghost: "btn-ghost", accent: "btn-accent" } as const;
export type ButtonVariant = keyof typeof VARIANTS;

/** Para links com cara de botão: `<Link className={buttonClass("ghost")}>`. */
export function buttonClass(variant: ButtonVariant = "primary", className = ""): string {
  return `btn ${VARIANTS[variant]} disabled:pointer-events-none disabled:opacity-60 ${className}`.trim();
}

export function Button({
  variant,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}
