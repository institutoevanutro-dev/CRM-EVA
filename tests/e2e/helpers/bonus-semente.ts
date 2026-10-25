/**
 * Semente do bônus da equipe para as provas em banco real.
 *
 * Usada por `bonus-consultas-banco-real.spec.ts`. Recebe os usuários já
 * criados (quem cria é o chamador: no e2e pelo GoTrue) e semeia pela service
 * role, como os specs vizinhos. Nada de nome real nem valor real: "Pessoa A",
 * centavos fictícios, telefone com sufixo aleatório.
 *
 * A fila sai assim (ordem de `fn_bonus_montar_fila`, 1 lead e 1 ligação por
 * pessoa, participantes na ordem [A, B]):
 *   - lead antigo L1 (inbound mais recente) → A; L2 → B;
 *   - ligação C1 (faltou há 5 dias) → A.
 */
import { randomInt, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { diaLocalISO } from "../../../lib/agenda/fuso";
import { ehDiaUtil } from "../../../lib/bonus/calendario";
import { relogioDoPrograma } from "../../../lib/bonus/fila";

const DIA_MS = 86_400_000;

/**
 * Um fuso em que AGORA é dia útil entre 0h e 11h local, para o cron montar a
 * fila de verdade (a regra usa `hora_local: 0`). Prefere a hora mais perto das
 * 6h, longe da virada do dia. `null` quando nenhum fuso serve (fim de semana
 * em UTC): aí a fila é montada pela mesma RPC, direto.
 */
export function fusoQueMontaAgora(agora: Date): string | null {
  let melhor: { fuso: string; distancia: number } | null = null;
  for (let h = -12; h <= 14; h++) {
    // Etc/GMT tem o sinal invertido: Etc/GMT-3 é UTC+3.
    const fuso = h === 0 ? "Etc/GMT" : `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`;
    const { hora, dia } = relogioDoPrograma(agora, fuso);
    if (!ehDiaUtil(dia, []) || hora >= 12) continue;
    const distancia = Math.abs(hora - 6);
    if (!melhor || distancia < melhor.distancia) melhor = { fuso, distancia };
  }
  return melhor?.fuso ?? null;
}

async function inserir(db: SupabaseClient, tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

function telefone(): string {
  return `+55279${randomInt(10_000_000, 99_999_999)}`;
}

export interface SementeDoBonus {
  org: string;
  fuso: string;
  hoje: string;
  etapaDeSinal: string;
  sessao: string;
  tipoDeConsulta: string;
  participanteA: string;
  participanteB: string;
  aprovador: string;
  l1: { contato: string; conversa: string; telefone: string };
  l2: { contato: string; conversa: string; telefone: string };
  c1: { contato: string; telefone: string };
}

/** Organização, três membros admins, canal, contatos e o programa (regra fictícia). */
export async function semearPrograma(
  db: SupabaseClient,
  usuarios: { participanteA: string; participanteB: string; aprovador: string },
  fuso: string,
  agora: Date,
): Promise<SementeDoBonus> {
  const etapaDeSinal = randomUUID();
  const org = await inserir(db, "organizations", {
    slug: `bonus-prova-${randomUUID()}`,
    display_name: "Bônus prova",
    legal_name: "Bônus prova",
    onboarded_at: agora.toISOString(),
    timezone: fuso,
    settings: { conversoes: { somente_de_anuncio: false, etapas_de_sinal_pago: [etapaDeSinal] } },
  });
  for (const user_id of [usuarios.participanteA, usuarios.participanteB, usuarios.aprovador]) {
    const { error } = await db
      .from("user_organizations")
      .insert({ organization_id: org, user_id, role: "admin", accepted_at: agora.toISOString() });
    if (error) throw new Error(`user_organizations: ${error.message}`);
  }
  const sessao = await inserir(db, "channel_sessions", {
    organization_id: org,
    waha_session_name: randomUUID(),
    display_name: "Canal de teste",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  const tipoDeConsulta = await inserir(db, "calendar_event_types", {
    organization_id: org,
    name: "Consulta de prova",
    slug: `consulta-prova-${randomInt(1000, 9999)}`,
    duration_minutes: 30,
    is_active: true,
    default_owner_user_id: usuarios.aprovador,
  });

  // Leads antigos: inbound há 40 e 45 dias, nada desde então (regra: 30 dias sem mensagem).
  const leadAntigo = async (nome: string, diasAtras: number) => {
    const fone = telefone();
    const contato = await inserir(db, "contacts", { organization_id: org, name: nome, display_name: nome, phone_number: fone });
    const quando = new Date(agora.getTime() - diasAtras * DIA_MS).toISOString();
    const conversa = await inserir(db, "conversations", {
      organization_id: org,
      contact_id: contato,
      channel_session_id: sessao,
      status: "resolved",
      last_inbound_at: quando,
      last_message_at: quando,
    });
    return { contato, conversa, telefone: fone };
  };
  const l1 = await leadAntigo("Pessoa A Lead", 40);
  const l2 = await leadAntigo("Pessoa B Lead", 45);

  // Ligação: faltou há 5 dias (regra: falta nos últimos 30 dias).
  const foneC1 = telefone();
  const c1 = await inserir(db, "contacts", {
    organization_id: org,
    name: "Pessoa C Ligacao",
    display_name: "Pessoa C Ligacao",
    phone_number: foneC1,
  });
  const falta = new Date(agora.getTime() - 5 * DIA_MS);
  await inserir(db, "calendar_appointments", {
    organization_id: org,
    contact_id: c1,
    event_type_id: tipoDeConsulta,
    owner_user_id: usuarios.aprovador,
    title: "Consulta de prova",
    status: "no_show",
    starts_at: falta.toISOString(),
    ends_at: new Date(falta.getTime() + 30 * 60_000).toISOString(),
  });

  await inserir(db, "bonus_programas", {
    organization_id: org,
    aprovador_user_id: usuarios.aprovador,
    ativo: true,
    regras: {
      participantes: [usuarios.participanteA, usuarios.participanteB],
      tarefas: { valor_cents: 20000 },
      resultados: { comparecimento: { valor_cents: 10000 }, sinal_pago: { valor_cents: 10000 } },
      rotinas: { leads_por_dia: 1, ligacoes_por_dia: 1, stories_por_dia: 2 },
      fila: { hora_local: 0 },
    },
  });

  return {
    org,
    fuso,
    hoje: diaLocalISO(agora, fuso),
    etapaDeSinal,
    sessao,
    tipoDeConsulta,
    ...usuarios,
    l1,
    l2,
    c1: { contato: c1, telefone: foneC1 },
  };
}

/**
 * Os fatos do mês, semeados DEPOIS de a fila existir (senão mudariam a fila):
 * A enviou a L1 hoje pelo CRM; A tem uma tarefa feita hoje no prazo, uma aberta
 * para hoje e uma do mês que vem (não pode contar); stories de hoje lançados à
 * mão (3); um comparecimento hoje; um lead entrou na etapa de sinal pago.
 */
export async function semearFatos(db: SupabaseClient, s: SementeDoBonus, agora: Date): Promise<void> {
  const iso = agora.toISOString();
  await inserir(db, "messages", {
    organization_id: s.org,
    contact_id: s.l1.contato,
    conversation_id: s.l1.conversa,
    channel_session_id: s.sessao,
    direction: "outbound",
    type: "text",
    body: "Olá, tudo bem?",
    status: "sent",
    sent_via: "user",
    sent_by_user_id: s.participanteA,
    sent_at: iso,
    external_id: randomUUID(),
  });
  const tarefa = (titulo: string, status: string, due: Date) =>
    inserir(db, "crm_tasks", {
      organization_id: s.org,
      title: titulo,
      status,
      due_date: due.toISOString(),
      assigned_to: s.participanteA,
    });
  await tarefa("Tarefa feita", "done", agora);
  await tarefa("Tarefa aberta", "pending", agora);
  await tarefa("Tarefa do mes que vem", "done", new Date(agora.getTime() + 40 * DIA_MS));

  const { error } = await db
    .from("bonus_stories_dia")
    .insert({ organization_id: s.org, dia: s.hoje, story_ids: [], contagem_manual: 3, lancado_por: s.aprovador });
  if (error) throw new Error(`bonus_stories_dia: ${error.message}`);

  await inserir(db, "calendar_appointments", {
    organization_id: s.org,
    contact_id: s.l2.contato,
    event_type_id: s.tipoDeConsulta,
    owner_user_id: s.aprovador,
    title: "Consulta de prova",
    status: "completed",
    starts_at: iso,
    ends_at: new Date(agora.getTime() + 30 * 60_000).toISOString(),
  });
  await inserir(db, "event_log", {
    organization_id: s.org,
    event_type: "lead.stage_changed",
    entity_kind: "lead",
    entity_id: randomUUID(),
    payload: { to_stage_id: s.etapaDeSinal },
    // Já consumido: nenhum worker do e2e deve agir sobre um lead de mentira.
    status: "done",
  });
}

interface ItemNaTela {
  tipo: string;
  contato_nome: string;
  telefone: string | null;
  motivo: string | null;
  enviada: boolean;
}
interface PessoaNoPlacar {
  userId: string;
  tarefas: { feitos: number; pendentes: number; naoFeitos: { tipo: string; ref: string }[] };
}
interface Resultado {
  chave: string;
  contagem: number | null;
}

/**
 * O que as três leituras TÊM de devolver para a semente acima. Devolve a lista
 * de divergências (vazia = tudo certo), para o e2e e a sonda local usarem a
 * MESMA régua. `diaUtil`: hoje conta rotinas e stories (dia útil local).
 */
export function divergencias(
  s: SementeDoBonus,
  r: {
    meuA: { fila: ItemNaTela[] | null; stories_hoje: { contagem: number }; pessoa: { userId: string }; resultados: Resultado[] };
    meuB: { fila: ItemNaTela[] | null };
    equipe: { placar: { resultados: Resultado[]; pessoas: PessoaNoPlacar[] }; stories_hoje: { contagem: number } };
  },
): string[] {
  const erros: string[] = [];
  const confere = (rotulo: string, obtido: unknown, esperado: unknown) => {
    if (JSON.stringify(obtido) !== JSON.stringify(esperado)) {
      erros.push(`${rotulo}: esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);
    }
  };
  const diaUtil = ehDiaUtil(s.hoje, []);

  const filaA = [...(r.meuA.fila ?? [])].sort((a, b) => a.tipo.localeCompare(b.tipo));
  confere(
    "/meu A: fila (embed contacts)",
    filaA.map((i) => [i.tipo, i.contato_nome, i.telefone, i.motivo, i.enviada]),
    [
      ["lead_antigo", "Pessoa A Lead", s.l1.telefone, null, true],
      ["ligacao", "Pessoa C Ligacao", s.c1.telefone, "faltou", false],
    ],
  );
  confere("/meu A: pessoa", r.meuA.pessoa.userId, s.participanteA);
  confere("/meu A: stories de hoje", r.meuA.stories_hoje.contagem, 3);
  confere(
    "/meu B: fila só dele",
    (r.meuB.fila ?? []).map((i) => [i.tipo, i.telefone]),
    [["lead_antigo", s.l2.telefone]],
  );

  for (const [rotulo, resultados] of [
    ["/meu A", r.meuA.resultados],
    ["/equipe", r.equipe.placar.resultados],
  ] as const) {
    const contagem = (chave: string) => resultados.find((x) => x.chave === chave)?.contagem;
    confere(`${rotulo}: comparecimento`, contagem("comparecimento"), 1);
    confere(`${rotulo}: sinal pago (embed organizations.settings)`, contagem("sinal_pago"), 1);
  }

  confere("/equipe: stories de hoje", r.equipe.stories_hoje.contagem, 3);
  const pessoa = (id: string) => r.equipe.placar.pessoas.find((p) => p.userId === id);
  const a = pessoa(s.participanteA);
  const b = pessoa(s.participanteB);
  // A, dia útil: feitos = tarefa no prazo + leads de hoje + stories de hoje;
  // pendentes = tarefa aberta de hoje + ligação de hoje. Fim de semana: só as tarefas.
  confere("/equipe: A (.or das tarefas, .in das mensagens)", a && [a.tarefas.feitos, a.tarefas.pendentes], diaUtil ? [3, 2] : [1, 1]);
  // B, dia útil: stories de hoje feitos; leads de hoje pendentes (não enviou).
  confere("/equipe: B", b && [b.tarefas.feitos, b.tarefas.pendentes], diaUtil ? [1, 1] : [0, 0]);
  // O que fica de "não feito" é só story de dia útil passado (a semente não lança).
  const estranhos = (a?.tarefas.naoFeitos ?? []).filter((n) => n.tipo !== "stories" || n.ref >= s.hoje);
  confere("/equipe: A não feitos além de stories passados", estranhos, []);
  return erros;
}
