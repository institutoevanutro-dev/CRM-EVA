import type { MetadataRoute } from "next";

import { versaoDoIcone } from "@/lib/branding/icone-versao";
import { marcaDaSaida } from "@/lib/branding/saida";

// Sem esta linha o `next build` resolve o manifest UMA vez e congela a marca de quem buildou
// dentro da imagem, que é uma só para todos os clones: medido em produção em 01/10/2026, o
// manifest dizia "DeskcommCRM" e `/icon?v=d` com a marca e o ícone da instalação já trocados.
// Mesma régua de `app/icon.tsx`.
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [marca, versao] = await Promise.all([marcaDaSaida(null), versaoDoIcone()]);
  return {
    name: marca.nome,
    short_name: marca.nome,
    display: "standalone",
    start_url: "/app",
    scope: "/",
    icons: [{ src: `/icon?v=${versao}`, sizes: "64x64", type: "image/png" }],
  };
}
