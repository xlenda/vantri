// Cria um admin com senha temporária: `npm run seed:admin -- email@exemplo.com` (SEED_ADMIN_PASSWORD fixa a senha; senão é aleatória).
// Usa DATABASE_URL (produção) ou, sem ela, o PGlite local em .data/pglite (pare o `next dev` antes: um processo por vez).
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "@/lib/auth/password";
import { randomBase62 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { logError } from "@/lib/log";

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Minúsculo e sem espaços (o banco tem CHECK email = lower(email)); inválido → null. */
export const parseAdminEmail = (raw: string): string | null => emailSchema.safeParse(raw).data ?? null;

export async function seedAdmin(rawEmail: string, password?: string): Promise<{ email: string; tempPassword: string }> {
  const email = parseAdminEmail(rawEmail);
  if (!email) throw new Error("E-mail inválido.");
  if (password !== undefined && password.length < 12) throw new Error("Senha informada curta demais: mínimo de 12 caracteres.");
  // O UNIQUE de users.email também barra corrida; aqui é só para a mensagem clara.
  const [exists] = await db().select({ id: users.id }).from(users).where(eq(users.email, email));
  if (exists) throw new Error(`Já existe um usuário com o e-mail ${email}. Nada foi alterado.`);
  const tempPassword = password ?? randomBase62(16);
  await db()
    .insert(users)
    .values({ email, passwordHash: await hashPassword(tempPassword), role: "admin", adminRole: "admin", mustChangePassword: true });
  return { email, tempPassword };
}

async function main() {
  // Valida antes de abrir o banco: abrir o PGlite só para fechar no meio das migrations trava o processo.
  if (!parseAdminEmail(process.argv[2] ?? "")) {
    console.error("E-mail inválido. Uso: npm run seed:admin -- email@exemplo.com");
    process.exitCode = 1;
    return;
  }
  try {
    const r = await seedAdmin(process.argv[2], process.env.SEED_ADMIN_PASSWORD || undefined);
    console.log(`Admin criado: ${r.email}`);
    console.log(`Senha temporária (aparece só agora): ${r.tempPassword}`);
    console.log("No primeiro acesso ele ativa o 2FA e troca a senha.");
  } catch (e) {
    process.exitCode = 1;
    if (e instanceof Error && e.message.startsWith("Já existe")) console.error(e.message);
    else logError("seed-admin: falha ao criar admin", e);
  } finally {
    // Fecha a conexão (postgres-js: end; PGlite local: close) para o processo terminar e o PGlite gravar limpo.
    const client = (db() as unknown as { $client: { end?: () => Promise<void>; close?: () => Promise<void> } }).$client;
    await (client.end ?? client.close)?.call(client);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
