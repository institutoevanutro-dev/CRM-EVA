/**
 * O texto do aviso de etapa (`crm_stages.avisar_na_central`, migration 0387).
 *
 * Módulo PURO, sem banco: quem escreve o aviso
 * (`./aviso-de-etapa.handler.ts`) monta o título por aqui, e é por este mesmo
 * título que o handler reconhece um aviso já aberto — as duas pontas não podem
 * divergir.
 *
 * O título diz só a ETAPA, entre aspas angulares: o título do negócio costuma
 * ser o nome ou o telefone do cliente, e a Central mostra o texto como foi
 * gravado. Quem abre o aviso vê o negócio com a permissão que tem.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/** A chave do dicionário do começo do título. */
const INICIO_DO_TITULO = "Negócio entrou em";

export function tituloDoAvisoDeEtapa(etapa: string, idioma: Idioma): string {
  return `${traduzir(INICIO_DO_TITULO, idioma)} «${etapa}»`;
}

export function corpoDoAvisoDeEtapa(idioma: Idioma): string {
  return traduzir(
    "Abra o negócio para dar o próximo passo. Este aviso foi pedido na configuração da etapa.",
    idioma,
  );
}
