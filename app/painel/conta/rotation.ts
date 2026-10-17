import { cookieOptions } from "@/lib/auth/session";

// Cookie do segredo novo pendente na troca de app autenticador (beginTotpRotation). Só vai para /painel/conta/*,
// vive 10 minutos (o mesmo prazo de dentro do valor cifrado) e nunca é lido pelo JavaScript da página.
export const TOTP_ROTATION_COOKIE = "vantri_totp_novo";
export const ROTATION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: cookieOptions.secure,
  sameSite: "strict",
  path: "/painel/conta",
  maxAge: 600,
} as const;
