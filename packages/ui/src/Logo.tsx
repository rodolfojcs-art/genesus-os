/**
 * Logo Genesus — spec SVG definitiva, 4 barras. NUNCA modificar las
 * coordenadas (regla §3 del master prompt y del design system).
 */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 300 295"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Genesus"
    >
      <polygon points="67,65 93,65 46,195 20,195" fill="#7B68FF" />
      <polygon points="149,50 175,50 108,235 82,235" fill="#00D4A0" />
      <polygon points="188,148 214,148 174,258 148,258" fill="#FFC040" />
      <polygon points="242,200 268,200 241,275 215,275" fill="#F06292" />
    </svg>
  );
}
