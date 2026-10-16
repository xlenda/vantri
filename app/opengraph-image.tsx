import { ImageResponse } from "next/og";
import { MARK, WORD, WORD_DOT } from "./(site)/components/Logo";
import { FEE_IN } from "./(site)/site";

export const alt = "Vantri: Pix para vendas digitais";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 80, background: "#f6f6f1", color: "#0e1120" }}>
        <svg width={388} height={96} viewBox="0 0 194 48">
          <path d={MARK.left} fill="#3b37f2" />
          <path d={MARK.right} fill="#0e1120" />
          <path d={MARK.cross} fill="#c9f25b" />
          <g transform="translate(58 6) scale(1.2)">
            <path d={WORD} fill="none" stroke="#0e1120" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={WORD_DOT.cx} cy={WORD_DOT.cy} r={WORD_DOT.r} fill="#0e1120" />
          </g>
        </svg>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 84, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>Receba Pix nas suas</div>
          <div style={{ display: "flex", fontSize: 84, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>
            <span style={{ background: "#c9f25b", padding: "0 12px" }}>vendas digitais.</span>
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 32, color: "#646a7a" }}>{`${FEE_IN} por Pix recebido · sem mensalidade · sem setup`}</div>
      </div>
    ),
    size,
  );
}
