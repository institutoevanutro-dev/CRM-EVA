/**
 * As regras puras do "Novo agendamento" simples (modal de duas abas).
 *
 * A ordem da tela é PROFISSIONAL → PROCEDIMENTO → UNIDADE, e as ligações são as
 * únicas que o banco tem: `calendar_event_types.default_owner_user_id` (quem
 * atende o procedimento) e as janelas da jornada com `unit_id` (onde a pessoa
 * atende). Um procedimento com dono aparece só para o dono; um procedimento SEM
 * dono é de qualquer profissional e aparece para todos. Não existe tabela de
 * "quem atende o quê" com mais de uma pessoa por tipo; se um dia existir, a
 * troca é aqui.
 */

/** O mínimo que a regra precisa saber de um tipo de agendamento. */
export type ProcedimentoComDono = { id: string; donoId: string | null };

/**
 * O profissional atende este procedimento? É dele, ou não tem dono (é de todos).
 *
 * A MESMA pergunta na tela (`procedimentosDoProfissional`) e na rota que marca
 * (`marcarAgendamentoHandler`): a tela só oferece o que a rota aceita.
 *
 * ⚠️ Até 20/11/2026 o `default_owner_user_id` era tratado como dono PADRÃO, não
 * exclusivo: a tela listava os procedimentos dos colegas num grupo "de outros
 * profissionais" e a rota aceitava marcar o tipo de uma pessoa na agenda de
 * outra. O dono da clínica pediu o contrário — escolhido o profissional, só os
 * procedimentos cadastrados para ele —, e as duas pontas mudaram juntas.
 */
export function atendeOProcedimento(donoDoTipo: string | null, profissionalId: string | null | undefined): boolean {
  return Boolean(profissionalId) && (donoDoTipo === null || donoDoTipo === profissionalId);
}

/**
 * Os procedimentos que o profissional escolhido atende. Sem profissional, nada:
 * a tela deixa o campo de procedimento desligado até ele ser escolhido.
 */
export function procedimentosDoProfissional<T extends ProcedimentoComDono>(
  tipos: readonly T[],
  profissionalId: string | null | undefined,
): T[] {
  return tipos.filter((t) => atendeOProcedimento(t.donoId, profissionalId));
}

/**
 * Onde o profissional atende, lido das janelas da JORNADA
 * (`attendant_availability.schedule.windows[].unit_id`) — é a única ligação
 * entre pessoa e unidade que o banco tem. `semUnidade` diz se alguma janela não
 * tem unidade (teleconsulta, ou jornada que nunca disse onde).
 */
export function unidadesDaJornada(janelas: ReadonlyArray<{ unit_id?: string | null }>): {
  unidades: string[];
  semUnidade: boolean;
} {
  const unidades = [...new Set(janelas.flatMap((j) => (j.unit_id ? [j.unit_id] : [])))];
  return { unidades, semUnidade: janelas.some((j) => !j.unit_id) };
}

/** O que a tela sabe da jornada de um profissional; ausente = não sabe. */
export type UnidadesDoProfissional = { unidades?: readonly string[]; atendeSemUnidade?: boolean };

/**
 * As unidades que a marcação oferece para o profissional.
 *
 * - A jornada dele DIZ onde atende → só essas (ativas), e "sem unidade" apenas
 *   se alguma janela não tem unidade.
 * - A jornada não diz (nenhuma janela com unidade, ou a tela não sabe) → todas
 *   as ativas, como sempre foi: esconder tudo travaria a marcação de quem nunca
 *   ligou unidade à jornada. `daJornada: false` deixa a tela avisar.
 */
export function ofertaDeUnidades<U extends { id: string; active: boolean }>(
  unidades: readonly U[],
  pessoa: UnidadesDoProfissional | undefined,
): { unidades: U[]; semUnidade: boolean; daJornada: boolean } {
  const ativas = unidades.filter((u) => u.active);
  const daJornada = pessoa?.unidades ?? [];
  if (daJornada.length === 0) return { unidades: ativas, semUnidade: true, daJornada: false };
  const dele = ativas.filter((u) => daJornada.includes(u.id));
  // Unidade da jornada desativada não deixa o campo sem opção nenhuma.
  return { unidades: dele, semUnidade: pessoa?.atendeSemUnidade === true || dele.length === 0, daJornada: true };
}

/**
 * A unidade que vale para a oferta: a escolhida, se ainda é dele; a única, se só
 * há uma; senão "" — que é "Teleconsulta ou sem unidade" quando a oferta tem
 * essa opção, e "falta escolher" quando não tem.
 */
export function unidadeDaMarcacao(
  oferta: { unidades: ReadonlyArray<{ id: string }>; semUnidade: boolean },
  atual: string,
): string {
  if (atual && oferta.unidades.some((u) => u.id === atual)) return atual;
  if (!oferta.semUnidade && oferta.unidades.length === 1) return oferta.unidades[0]!.id;
  return "";
}

/** O instante em que o atendimento termina: começo + duração do procedimento. */
export function fimDoHorario(instante: string, duracaoMin: number): string {
  return new Date(new Date(instante).getTime() + duracaoMin * 60_000).toISOString();
}

/**
 * Todos os dias de `inicio` a `fim`, inclusive (`yyyy-MM-dd`). Sem `fim`, ou com
 * `fim` antes do início, é o próprio dia. O teto segura um ano digitado errado,
 * que viraria centenas de linhas para apagar uma a uma.
 *
 * Meio-dia UTC pela mesma razão de `DiasBloqueados`: a aritmética é de DIAS, e
 * meia-noite somada a fuso a oeste volta um dia ao formatar.
 */
export function datasDoPeriodo(inicio: string, fim: string | null | undefined, teto: number): string[] {
  const ultimo = new Date(`${fim && fim > inicio ? fim : inicio}T12:00:00Z`).getTime();
  const datas: string[] = [];
  for (let d = new Date(`${inicio}T12:00:00Z`); d.getTime() <= ultimo; d.setUTCDate(d.getUTCDate() + 1)) {
    if (datas.length >= teto) break;
    datas.push(d.toISOString().slice(0, 10));
  }
  return datas;
}

/**
 * Idade em anos completos em `agora`. `nascimento` é a coluna `date` do contato
 * (`YYYY-MM-DD`, sem fuso), lida como dia de calendário — `new Date("1990-03-12")`
 * seria meia-noite UTC e, a oeste de Greenwich, o dia anterior. `null` para data
 * ilegível ou futura.
 */
export function idadeEmAnos(nascimento: string | null | undefined, agora: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(nascimento ?? "");
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const aindaNaoFez = agora.getMonth() + 1 < mes || (agora.getMonth() + 1 === mes && agora.getDate() < dia);
  const idade = agora.getFullYear() - ano - (aindaNaoFez ? 1 : 0);
  return idade >= 0 && idade < 150 ? idade : null;
}

/** `YYYY-MM-DD` → `DD/MM/AAAA`, sem passar por `Date` (pelo mesmo motivo de `idadeEmAnos`). */
export function dataDeCalendario(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/**
 * A última consulta que já passou e a próxima que vem, das que a ficha do contato
 * traz (`consultas`: até 3 de cada lado, sem canceladas).
 */
export function ultimaEProximaConsulta<C extends { starts_at: string }>(
  consultas: readonly C[],
  agora: Date,
): { ultima: C | null; proxima: C | null } {
  const t = agora.getTime();
  const passadas = consultas.filter((c) => new Date(c.starts_at).getTime() < t);
  const futuras = consultas.filter((c) => new Date(c.starts_at).getTime() >= t);
  const porInicio = (a: C, b: C) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  return { ultima: passadas.sort(porInicio).at(-1) ?? null, proxima: futuras.sort(porInicio)[0] ?? null };
}
