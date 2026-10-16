// Taxa em centavos: parte percentual (pontos-base, 149 = 1,49%) arredondada + parte fixa.
export function computeFee(amountCents: number, bps: number, fixedCents: number): number {
  return Math.round((amountCents * bps) / 10000) + fixedCents;
}
