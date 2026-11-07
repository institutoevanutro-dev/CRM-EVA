/**
 * Quem aparece na lista de destinos da janela Encaminhar.
 *
 * A busca filtrava com `rotulo.toLowerCase().includes(termo)`, que ignora caixa
 * mas não acento: quem digitava `joao` não achava "João". Os dois lados passam
 * agora por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`).
 *
 * Portado do projeto original (DeskcommCRM, PR #4078 de @bfs2021, issue #4072).
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

export interface DestinoDeEncaminhamento {
  id: string;
  rotulo: string;
}

/** Filtra pelo termo, preservando a ordem. Termo vazio devolve a lista inteira. */
export function filtrarDestinos<T extends DestinoDeEncaminhamento>(destinos: T[], busca: string): T[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return destinos;
  return destinos.filter((destino) => termoSemAcento(destino.rotulo).includes(termo));
}
