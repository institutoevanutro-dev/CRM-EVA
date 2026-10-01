import type { MetadataRoute } from "next";

import { versaoDoIcone } from "@/lib/branding/icone-versao";
import { marcaDaSaida } from "@/lib/branding/saida";

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
