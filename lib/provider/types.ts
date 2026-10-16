export type PixKeyType = 'cpf'|'cnpj'|'email'|'phone'|'evp'

export interface PixProvider {
  name: string
  createAccount(i: { merchantId: string; legalName: string; document: string; documentType: 'cpf'|'cnpj'; email: string }): Promise<{ providerAccountId: string }>
  createCharge(i: { providerAccountId: string; amountCents: number; txid: string; description?: string; expiresInSec: number }): Promise<{ providerChargeId: string; brcode: string }>
  createPayout(i: { providerAccountId: string; amountCents: number; pixKey: string; pixKeyType: PixKeyType; idempotencyKey: string; description?: string }): Promise<{ providerPayoutId: string; status: 'processing'|'completed'|'failed'; failureCode?: string; endToEndId?: string }>
  getPayout(providerPayoutId: string): Promise<{ status: 'processing'|'completed'|'failed'; failureCode?: string; endToEndId?: string }>
  parseWebhook(req: { headers: Headers; rawBody: string }): Promise<ProviderEvent[]>  // lança se a autenticação falhar
}
export type ProviderEvent =
  | { type: 'charge.paid'; providerChargeId: string; paidAt: Date; endToEndId: string; payerName?: string; payerDocument?: string }
  | { type: 'payout.completed'; providerPayoutId: string; endToEndId: string }
  | { type: 'payout.failed'; providerPayoutId: string; failureCode: string }
  | { type: 'med.opened'; providerChargeId: string; providerCaseId: string; amountCents: number; reason: string; deadline: Date }
  | { type: 'med.closed'; providerCaseId: string; outcome: 'merchant_won'|'payer_refunded' }
