/**
 * Quem pode assumir AGORA, do lado do motor — e a frase que o agente lê.
 *
 * ## O defeito que isto conserta (ACH-03)
 *
 * A capacidade `crm_list_available_attendants` existia, estava ligada e foi
 * montada no turno — e o agente escalou sem chamá-la. Medido num turno real:
 * ele abriu o chamado e disse ao cliente *"vou providenciar para que alguém da
 * equipe entre em contato"*, sem prazo e sem saber se havia alguém para receber.
 *
 * Capacidade que depende de o modelo LEMBRAR de usar é capacidade que não
 * existe metade das vezes. A doutrina do repo é explícita: não confiar na
 * disciplina do modelo para o que o sistema pode garantir. Então o próprio
 * caminho de escalação passa a consultar e a DEVOLVER a expectativa junto com a
 * confirmação — a promessa ao cliente nasce honesta sem ninguém precisar
 * lembrar de nada.
 *
 * ## Por que duplica a consulta de `atendentes.ts`
 *
 * Não duplica a REGRA: a elegibilidade é `isAttendantEligible`, a mesma função
 * pura que o worker de roteamento e a rota do painel usam. O que difere é o
 * CLIENTE — a API fala supabase-js e o motor fala `pg` (roda fora do request).
 * É o mesmo par que `emitLeadActivity` (supabase) e `emitAgentActivityForContact`
 * (pg) formam sobre `buildLeadActivityRow`: dois leitores, uma regra.
 */
import { diaDaSemanaLocal, diaLocalISO, instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import {
  isAttendantEligible,
  isWithinSchedule,
  OPEN_LOAD_STATUSES,
} from "@/lib/routing/eligibility";
import { availabilityScheduleSchema, type AvailabilitySchedule } from "@/lib/schemas/routing";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

import type { Queryable } from "../agent-engine/queue/queue";

export interface QuemPodeAssumir {
  /** Atendentes elegíveis AGORA: disponível ∧ com folga ∧ dentro do horário. */
  disponiveis: number;
  /** Membros agent+ da organização, configurados ou não. */
  total: number;
  /**
   * Quando a equipe volta, já em palavras ("amanhã", "na segunda-feira"…), ou
   * `null`/ausente quando não se sabe ou não faz falta: alguém está dentro do
   * horário agora, alguém atende sem horário, ou ninguém configurou horário.
   * Ver {@link quandoAEquipeVolta}.
   */
  volta?: string | null;
}

interface LinhaDeDisponibilidade {
  user_id: string;
  role: string;
  capacity: number | null;
  schedule: unknown;
  carga: string;
  fuso_org?: string | null;
}

/**
 * Uma query só: roster agent+ ⟕ disponibilidade ⟕ carga (conversas abertas
 * atribuídas). A decisão de elegibilidade fica em TypeScript, na função pura
 * compartilhada — SQL que decidisse aqui seria a segunda regra.
 */
export async function quemPodeAssumirAgora(
  db: Queryable,
  tenantId: string,
  now: Date,
): Promise<QuemPodeAssumir> {
  const { rows } = await db.query<LinhaDeDisponibilidade>(
    `select uo.user_id,
            uo.role,
            aa.capacity,
            aa.schedule,
            (select count(*)
               from conversations c
              where c.organization_id = uo.organization_id
                and c.assigned_to_user_id = uo.user_id
                and c.status = any($2::text[])) as carga,
            (select o.timezone from organizations o where o.id = uo.organization_id) as fuso_org
       from user_organizations uo
       left join attendant_availability aa
         on aa.organization_id = uo.organization_id
        and aa.user_id = uo.user_id
        and aa.is_available
      where uo.organization_id = $1
        and uo.revoked_at is null`,
    [tenantId, OPEN_LOAD_STATUSES],
  );

  // Viewer não é insumo de roteamento — mesmo corte do roster da API.
  const atendentes = rows.filter(
    (r) => ROLE_RANK[r.role as Role] !== undefined && ROLE_RANK[r.role as Role] >= ROLE_RANK.agent,
  );

  // Quem participa do roteamento: tem linha de disponibilidade E está ligado
  // (o LEFT JOIN só traz `capacity` quando `is_available`). É deles que sai o
  // horário de volta; quem se desligou não volta sozinho às 8h de segunda.
  const agendas = atendentes
    .filter((r) => r.capacity !== null)
    .map((r) => availabilityScheduleSchema.parse(r.schedule ?? {}));
  const volta = quandoAEquipeVolta(agendas, now, fusoUtilizavel(rows[0]?.fuso_org));

  const disponiveis = atendentes.filter((r) => {
    // capacity null = quem nunca configurou disponibilidade, ou está offline (o
    // LEFT JOIN só traz a linha quando `is_available`). O worker de roteamento
    // também não o escolhe; prometer com ele contado seria prometer o que o
    // roteamento nunca vai entregar.
    if (r.capacity === null) return false;
    return isAttendantEligible(
      {
        isAvailable: true,
        capacity: r.capacity,
        currentLoad: Number(r.carga),
        schedule: availabilityScheduleSchema.parse(r.schedule ?? {}),
      },
      now,
    );
  }).length;

  return { disponiveis, total: atendentes.length, volta };
}

const DIAS_DA_SEMANA = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
] as const;

/** Primeiro início de janela DEPOIS de `now`, nos próximos 7 dias, no fuso da agenda. */
function proximoInicio(agenda: AvailabilitySchedule, now: Date): Date | null {
  const fuso = fusoUtilizavel(agenda.timezone);
  const hoje = partesNoFuso(now, fuso);
  const dowHoje = diaDaSemanaLocal(now, fuso);
  let melhor: Date | null = null;
  for (let d = 0; d <= 7; d++) {
    const dia = new Date(Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia + d));
    for (const w of agenda.windows) {
      if (w.dow !== (dowHoje + d) % 7) continue;
      const [hora, minuto] = w.start.split(":").map(Number);
      const inicio = instanteDe(
        { ano: dia.getUTCFullYear(), mes: dia.getUTCMonth() + 1, dia: dia.getUTCDate(), hora, minuto },
        fuso,
      );
      if (inicio > now && (melhor === null || inicio < melhor)) melhor = inicio;
    }
  }
  return melhor;
}

/**
 * QUANDO A EQUIPE VOLTA, em palavras que o paciente entende. Pura.
 *
 * A fonte é a jornada de cada atendente ("Atendentes e horários",
 * `attendant_availability.schedule`) — a mesma que o roteamento usa. Não há
 * configuração nova: o expediente da clínica JÁ está escrito ali, atendente por
 * atendente, e uma segunda fonte ("horário da clínica") divergiria dela.
 *
 * `null` (o chamador mantém o texto de hoje) quando:
 *   - ninguém participa do roteamento (nada configurado);
 *   - alguém atende sem janela (24/7) ou está dentro da janela agora;
 *   - nenhuma janela foi achada (não deveria acontecer com janela válida).
 *
 * Senão, o início mais cedo entre todos, rotulado no fuso da ORGANIZAÇÃO:
 * "hoje a partir das 14h" · "amanhã" · "na segunda-feira" ·
 * "na próxima terça-feira" (mesma semana-dia de hoje, uma semana à frente).
 *
 * ⚠️ FERIADO NÃO É MODELADO. A jornada é semanal; numa segunda de feriado a
 * frase dirá "na segunda-feira" e a equipe não estará lá. Errar por um dia é o
 * mesmo tamanho de erro que o roteamento já comete no feriado; modelar exige
 * calendário de feriados por organização, que o CRM não tem.
 */
export function quandoAEquipeVolta(
  agendas: AvailabilitySchedule[],
  now: Date,
  fusoDaOrg: string,
): string | null {
  if (agendas.length === 0) return null;
  if (agendas.some((a) => a.windows.length === 0 || isWithinSchedule(a, now))) return null;

  let inicio: Date | null = null;
  for (const a of agendas) {
    const p = proximoInicio(a, now);
    if (p !== null && (inicio === null || p < inicio)) inicio = p;
  }
  if (inicio === null) return null;

  const fuso = fusoUtilizavel(fusoDaOrg);
  const dias = Math.round(
    (Date.parse(diaLocalISO(inicio, fuso)) - Date.parse(diaLocalISO(now, fuso))) / 86_400_000,
  );
  if (dias === 0) {
    const p = partesNoFuso(inicio, fuso);
    const min = p.minuto === 0 ? "" : String(p.minuto).padStart(2, "0");
    return `hoje a partir das ${p.hora}h${min}`;
  }
  if (dias === 1) return "amanhã";
  const nome = DIAS_DA_SEMANA[diaDaSemanaLocal(inicio, fuso)]!;
  const masculino = nome === "sábado" || nome === "domingo";
  if (dias >= 7) return `${masculino ? "no próximo" : "na próxima"} ${nome}`;
  return `${masculino ? "no" : "na"} ${nome}`;
}

/**
 * A frase que vai para o MODELO junto com a confirmação da escalação.
 *
 * Pura e separada da leitura porque é ela que decide o que o cliente ouve — e
 * comparar frase é barato, comparar linha de banco é caro.
 *
 * Os três casos são diferentes de propósito. O terceiro é o da instalação
 * fresca: numa VPS recém-instalada NINGUÉM está em `attendant_availability`, e
 * sem esta frase o agente prometeria contato para o vazio na primeira conversa
 * do cliente — a pior primeira impressão possível num produto self-host.
 */
export function fraseDeExpectativa(q: QuemPodeAssumir): string {
  if (q.total === 0) {
    return (
      "ATENÇÃO: esta conta ainda não tem ninguém configurado para receber atendimento. " +
      "NÃO prometa que alguém entra em contato — diga que o pedido ficou registrado e que " +
      "a equipe responde assim que possível."
    );
  }
  if (q.disponiveis === 0 && q.volta) {
    return (
      `ATENÇÃO: a equipe está fora do horário de atendimento e só retorna ${q.volta}. ` +
      "NÃO prometa contato antes disso nem dê outro prazo. Diga que o pedido ficou registrado " +
      `e que a equipe retorna ${q.volta}.`
    );
  }
  if (q.disponiveis === 0) {
    return (
      "ATENÇÃO: não há ninguém da equipe disponível neste momento. NÃO prometa contato " +
      "imediato nem dê prazo curto — diga que o pedido ficou registrado e que a equipe " +
      "retorna assim que possível."
    );
  }
  const pessoas = q.disponiveis === 1 ? "1 pessoa" : `${q.disponiveis} pessoas`;
  return `Há ${pessoas} da equipe podendo assumir agora — pode dizer ao cliente que alguém continua o atendimento em seguida.`;
}

/**
 * Leitura + frase, com rede de segurança.
 *
 * Falha de leitura NÃO pode derrubar a escalação (o cliente está esperando), e
 * também não pode virar silêncio otimista: sem o dado, o agente recebe a
 * instrução conservadora — não prometer prazo. Errar para o lado de prometer
 * menos é recuperável; prometer o que não se cumpre, não.
 */
export async function expectativaDeAtendimento(
  db: Queryable,
  tenantId: string,
  now: Date,
): Promise<{ quem: QuemPodeAssumir | null; frase: string }> {
  try {
    const quem = await quemPodeAssumirAgora(db, tenantId, now);
    return { quem, frase: fraseDeExpectativa(quem) };
  } catch {
    return {
      quem: null,
      frase:
        "Não foi possível confirmar quem está disponível agora. NÃO prometa contato imediato " +
        "nem dê prazo — diga que o pedido ficou registrado.",
    };
  }
}
