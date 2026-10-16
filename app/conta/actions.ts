"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { changePassword, confirmTotpSetup } from "@/lib/auth/session";
import { accessSession, formText, homeFor } from "./acesso";

export async function confirmTotpAction(_prev: { error: string } | undefined, fd: FormData) {
  const { s, token } = await accessSession();
  if (!(await confirmTotpSetup(s.user.id, formText(fd, "code").replace(/\s/g, ""), token))) {
    return { error: "Código inválido. Confira se a data e a hora do celular estão automáticas e tente de novo." };
  }
  redirect(homeFor(s.user.role));
}

export type PasswordState = { error: string } | { done: true } | undefined;

const passwordSchema = z.strictObject({
  current: z.string().min(1).max(256),
  next: z.string().min(12).max(256),
});

export async function changePasswordAction(_prev: PasswordState, fd: FormData): Promise<PasswordState> {
  const { s, token } = await accessSession();
  if (!s.session.mfaPassed) redirect("/entrar/2fa");
  const input = passwordSchema.safeParse({ current: formText(fd, "current"), next: formText(fd, "next") });
  if (!input.success) return { error: "Preencha a senha atual e uma senha nova de 12 a 256 caracteres." };
  const { current, next } = input.data;
  if (next !== formText(fd, "confirm")) return { error: "A confirmação não é igual à senha nova." };
  if (next === current) return { error: "A senha nova precisa ser diferente da atual." };
  if (!(await changePassword(s.user.id, current, next, token))) return { error: "Senha atual incorreta." };
  return { done: true };
}
