import { ehHexValido, normalizarHex } from "@/lib/branding/rampa";

/**
 * As 6 paletas prontas do guia de marca. No CRM só a cor principal entra: ela vira a cor da marca
 * (`accent_hex`), e o CRM deriva o resto. Fundo e destaque do guia não têm onde morar aqui.
 * A paleta não é gravada; sai da cor gravada por `paletaDaCor`.
 */
export type IdDaPaleta = "verde-dourado" | "azul-petroleo" | "vinho" | "grafite" | "terracota" | "lavanda";
export type Paleta = { readonly id: IdDaPaleta; readonly nome: string; readonly principal: string };

export const PALETAS: readonly Paleta[] = [
  { id: "verde-dourado", nome: "Verde e dourado", principal: "#27463b" },
  { id: "azul-petroleo", nome: "Azul-petróleo", principal: "#1f4e5f" },
  { id: "vinho", nome: "Vinho", principal: "#6b2737" },
  { id: "grafite", nome: "Grafite", principal: "#3a3f47" },
  { id: "terracota", nome: "Terracota", principal: "#8a3f26" },
  { id: "lavanda", nome: "Lavanda", principal: "#4f3f7a" },
];

/** A paleta cuja principal é esta cor. `ehHexValido`/`normalizarHex` já aparam espaços e aceitam `#abc`. */
export function paletaDaCor(hex: string): IdDaPaleta | null {
  if (!ehHexValido(hex)) return null;
  const cor = normalizarHex(hex);
  return PALETAS.find((p) => p.principal === cor)?.id ?? null;
}
