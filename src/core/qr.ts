import { renderSVG, renderUnicodeCompact } from "uqr";

/** Render a QR code as an SVG document. Used by the login page. */
export function qrSvg(text: string): string {
  return renderSVG(text, { ecc: "M", border: 2, pixelSize: 4 });
}

/** Render a QR code with Unicode block characters for a terminal. */
export function qrTerminal(text: string): string {
  return renderUnicodeCompact(text, { ecc: "M", border: 1 });
}
