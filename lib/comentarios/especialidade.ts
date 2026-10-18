/**
 * A trava de RQE (o médico da clínica é CFM, sem título de especialidade) — a
 * IA nunca pode fazer o dono da conta parecer que anuncia especialidade
 * que ele não tem (`docs/865993ff`, commit "a IA nunca anuncia
 * especialidade que o dono não tem (CFM)").
 *
 * Compartilhado entre `workers/comentarios-worker.ts` (recusa a PUBLICAÇÃO
 * automática da IA) e `POST /api/v1/comentarios/:id/publicar` (recusa o
 * clique humano) — achado da revisão final: o worker recusava e gravava o
 * texto recusado em `sugestao_de_resposta`; a tela pré-preenchia o rascunho
 * com ELE MESMO, e o botão Publicar mandava pro Instagram sem reconferir
 * nada. Duas travas em dois arquivos por acidente é UMA trava que o segundo
 * caminho não tinha.
 *
 * RADICAIS, não palavras inteiras: a primeira versão ancorava `\b` nos DOIS
 * lados (`\bnutrologo\b`), o que só casava a forma exata — "nutrólogos"
 * (plural), "nutrologista" (derivação) e "especialização"/"especialidade"
 * (flexão) atravessavam intactos. `\b` só no INÍCIO do radical: qualquer
 * sufixo depois dele ainda casa.
 */
import { normalizarTexto } from "@/lib/opt-out/deteccao";

export const RADICAIS_DE_ESPECIALIDADE = ["nutrolog", "especialist", "especializ", "especialidad"];

/**
 * `null` = pode publicar: o texto não menciona título de especialidade, ou a
 * organização desligou a regra do RQE (`medicoSemRqe = false`, migration 0381,
 * lida por `lib/comentarios/regra-do-rqe.ts`). O padrão é ligada: quem não
 * passar a regra fica no lado seguro, que é o comportamento de antes de ela
 * ser por organização.
 */
export function motivoDaRecusaPorEspecialidade(texto: string, medicoSemRqe = true): string | null {
  if (!medicoSemRqe) return null;
  const normalizado = normalizarTexto(texto);
  for (const radical of RADICAIS_DE_ESPECIALIDADE) {
    if (new RegExp(`\\b${radical}`, "u").test(normalizado)) {
      return "O texto chama o dono de título de especialidade que ele não tem (CFM, sem RQE).";
    }
  }
  return null;
}
