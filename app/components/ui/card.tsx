import type { ComponentProps } from "react";

export function Card({ className = "", ...props }: ComponentProps<"div">) {
  return (
    <div
      className={`rounded-3xl border border-line bg-white p-6 shadow-[0_1px_0_rgb(14_17_32/0.04),0_16px_40px_-24px_rgb(14_17_32/0.25)] sm:p-8 ${className}`}
      {...props}
    />
  );
}
