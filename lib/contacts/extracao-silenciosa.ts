/**
 * EXTRAÇÃO SILENCIOSA DE CADASTRO (migration 0407).
 *
 * Quando a equipe atende pelo celular, a conversa fica silenciada para a IA
 * (`bot_silenced_until`) e o worker de resposta pula com
 * `silenced_post_handoff`. O CPF, o e-mail, a data de nascimento e o endereço
 * que o paciente manda DEPOIS que a equipe pede não eram lidos por ninguém — o
 * dono digitava à mão (medido: 21 conversas com pedido de dados em 30 dias).
 *
 * Esta peça lê essas mensagens SEM turno de resposta: nenhuma mensagem sai,
 * nada no estado de handoff/silêncio muda, e a IA continua parada. Ela é um
 * consumidor próprio de `message.received` (`workers/extracao-silenciosa.handler.ts`),
 * ao lado do worker de resposta — não dentro dele —, para que o `skip` de lá
 * continue intacto e as guardas daquele caminho (orçamento, agente publicado,
 * elegibilidade) não decidam se um cadastro é lido.
 *
 * O que ela faz, e só com `organizations.settings.crm.extracao_silenciosa`
 * LIGADA (nasce desligada, e falha de leitura lê como desligada):
 *  - CPF (com dígitos verificadores), e-mail e nascimento por REGRA FIXA;
 *  - endereço por uma chamada curta de modelo (ponto `extracao_de_cadastro`),
 *    e só quando a mensagem tem cara de endereço (CEP, "rua", "av."…);
 *  - campo VAZIO na ficha → grava (trava "ainda vazio" DENTRO do UPDATE);
 *  - valor DIFERENTE do gravado → proposta (`contact_field_proposals`) e um
 *    aviso `contact_data_divergent` na Central. Nunca sobrescreve.
 *
 * O que ela recusa: conversa em grupo, conversa em que a IA está atendendo (o
 * agente tem a ferramenta de proposta), contato bloqueado, anonimizado ou
 * juntado a outro, e mensagem já lida (idempotência pela auditoria da própria
 * mensagem, mais as travas do banco: o "ainda vazio" no UPDATE e o índice
 * único de proposta pendente).
 *
 * Trilha: `contact.field_auto_applied` / `contact.field_proposed` na auditoria
 * e `contact_field_auto_applied` na linha do tempo, todas com o id da mensagem
 * de origem e SEM o valor do dado. Nada de dado do paciente em log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { audit } from "@/lib/audit";
import { indiceDoCpf, mascararCpfsNoTexto, normalizeCpf, parDoCpf } from "@/lib/contacts/cpf";
import { enderecoDaFicha, proporDadoDoContato, valorAceitavel } from "@/lib/contacts/proposta-de-dado";
import { registrarDadoAplicadoNaTimeline } from "@/lib/contacts/telefone-aplicado";
import { env } from "@/lib/env";
import { silencioVigente } from "@/lib/inbox/comando-da-conversa";
import { logger } from "@/lib/logger";
import { isValidCpf } from "@/lib/schemas/contacts";
import { extracaoSilenciosaLigada } from "@/lib/schemas/settings";

export type CampoExtraido = "cpf" | "email" | "birthdate" | "endereco";

/** Como cada campo aparece para quem opera (timeline, aviso). */
const NOME: Record<CampoExtraido, string> = {
  cpf: "CPF",
  email: "E-mail",
  birthdate: "Data de nascimento",
  endereco: "Endereço",
};

/** Marca as linhas desta peça na auditoria e na timeline. */
export const ORIGEM = "extracao_silenciosa";

// ===========================================================================
// REGRA PURA
// ===========================================================================

function unico<T>(valores: T[]): T | null {
  const distintos = [...new Set(valores)];
  // Dois valores diferentes na mesma mensagem (o CPF dela e o do marido, dois
  // e-mails) é ambiguidade: quem decide é uma pessoa, não esta regra.
  return distintos.length === 1 ? distintos[0]! : null;
}

/**
 * O CPF da mensagem, só dígitos — ou `null`. Com pontuação (`000.000.000-00`)
 * vale sempre; 11 dígitos colados só valem com a palavra "CPF" na mensagem ou
 * no pedido da equipe logo antes (`contexto`), porque um celular com DDD
 * também tem 11 dígitos.
 */
export function extrairCpf(texto: string, contexto = ""): string | null {
  const comMascara = [...texto.matchAll(/(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g)].map((m) => m[0]);
  const colados = /\bcpf\b/i.test(`${texto}\n${contexto}`) ? [...texto.matchAll(/(?<![\d.-])\d{11}(?![\d.-])/g)].map((m) => m[0]) : [];
  return unico([...comMascara, ...colados].map(normalizeCpf).filter(isValidCpf));
}

/** O e-mail da mensagem, minúsculo — ou `null` (nenhum, ou mais de um). */
export function extrairEmail(texto: string): string | null {
  const achados = [...texto.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)]
    .map((m) => m[0].toLowerCase())
    .filter((e) => valorAceitavel("email", e));
  return unico(achados);
}

const PALAVRA_DE_NASCIMENTO = /nasc|nasci|anivers|\bd\.?\s?n\b/i;

/**
 * A data de nascimento da mensagem em `AAAA-MM-DD` — ou `null`.
 *
 * Data solta numa conversa quase nunca é nascimento ("pode ser dia
 * 15/12?"), então só conta quando a mensagem — ou o pedido da equipe logo
 * antes dela (`contexto`) — diz que é ("nascimento", "nasci", "DN"), ou quando
 * a mensagem é um bloco de cadastro (tem CPF ou e-mail junto); sem a palavra, a
 * data precisa ter pelo menos um ano. Formatos BR: `dd/mm/aaaa`, `dd-mm-aaaa`,
 * `dd.mm.aaaa` e ano com 2 dígitos.
 */
export function extrairNascimento(texto: string, agora: Date = new Date(), contexto = ""): string | null {
  const comPalavra = PALAVRA_DE_NASCIMENTO.test(`${texto}\n${contexto}`);
  if (!comPalavra && !extrairCpf(texto) && !extrairEmail(texto)) return null;

  const anoAtual = agora.getUTCFullYear();
  const umAnoAtras = Date.UTC(anoAtual - 1, agora.getUTCMonth(), agora.getUTCDate());
  const candidatas: string[] = [];
  for (const m of texto.matchAll(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/.-])/g)) {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    let ano = Number(m[3]);
    if (m[3]!.length === 2) ano += ano > anoAtual % 100 ? 1900 : 2000;
    if (ano < 1900) continue;
    const t = Date.UTC(ano, mes - 1, dia);
    const d = new Date(t);
    if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) continue;
    if (t > agora.getTime() || ano < anoAtual - 120) continue;
    if (!comPalavra && t > umAnoAtras) continue;
    candidatas.push(`${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`);
  }
  return unico(candidatas);
}

/**
 * A mensagem TEM CARA de endereço? É o portão do modelo: só chama quando há
 * CEP ou um tipo de logradouro com número. Errar para o lado de chamar custa
 * uma chamada curta; o modelo devolve `null` para "tô na rua, chego em 5".
 */
export function temIndicioDeEndereco(texto: string): boolean {
  if (/(?<!\d)\d{5}-?\d{3}(?!\d)/.test(mascararCpfsNoTexto(texto))) return true;
  const logradouro =
    /\b(rua|r\.|av\.?|avenida|travessa|tv\.|alameda|rodovia|estrada|pra[çc]a|largo|quadra|qd\.?|lote|bairro|condom[ií]nio|apto|apartamento|bloco)\b/i;
  return logradouro.test(texto) && /\d/.test(texto);
}

/** Os campos de regra fixa que a mensagem traz. */
export function extrairDeterministico(
  texto: string,
  agora: Date = new Date(),
  contexto = "",
): Partial<Record<"cpf" | "email" | "birthdate", string>> {
  const r: Partial<Record<"cpf" | "email" | "birthdate", string>> = {};
  const cpf = extrairCpf(texto, contexto);
  const email = extrairEmail(texto);
  const nascimento = extrairNascimento(texto, agora, contexto);
  if (cpf) r.cpf = cpf;
  if (email) r.email = email;
  if (nascimento) r.birthdate = nascimento;
  return r;
}

/** Endereço comparável: sem acento, caixa, pontuação e espaço. */
export function enderecoComparavel(e: string): string {
  return e
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export type Acao = "preencher" | "propor" | "nada";

/** A regra do dono: campo vazio preenche, igual não faz nada, diferente propõe. */
export function decidir(atual: string | null, igual: boolean): Acao {
  if (atual === null || atual.trim() === "") return "preencher";
  return igual ? "nada" : "propor";
}

/**
 * A conversa está com a EQUIPE? Silêncio vigente (a mesma régua da tela e do
 * worker de resposta), pessoa atribuída, ou contato passado a humano. Fora
 * disso a IA atende, e o agente tem a sua própria ferramenta de proposta.
 */
export function conversaDaEquipe(
  conversa: { bot_silenced_until: string | null; assignee_kind: string | null },
  contato: { force_human?: boolean | null },
  agora: Date,
): boolean {
  return (
    silencioVigente(conversa.bot_silenced_until, agora).vigente ||
    conversa.assignee_kind === "user" ||
    contato.force_human === true
  );
}

// ===========================================================================
// O ENDEREÇO PELO MODELO
// ===========================================================================

const respostaDoModelo = z.object({ endereco: z.string().trim().min(8).max(200).nullable() });

export const INSTRUCAO_DO_ENDERECO =
  "Você lê UMA mensagem que um cliente mandou para a equipe de uma empresa e extrai o endereço residencial DELE, " +
  "se a mensagem trouxer um. Não responde ao cliente. Responda SOMENTE com JSON no formato " +
  '{"endereco": "..."} ou {"endereco": null}. Escreva o endereço numa linha, com as partes separadas por vírgula ' +
  "(logradouro, número, complemento, bairro, cidade, UF, CEP), usando só o que está na mensagem — nunca invente " +
  "nem complete. Responda null quando não houver endereço, quando for endereço de outra pessoa ou da empresa, ou " +
  "quando a mensagem só mencionar um lugar sem dizer onde o cliente mora.";

/** Lê o `{"endereco": …}` da saída do modelo. Saída fora do formato → `null`. */
export function lerRespostaDoEndereco(texto: string): string | null {
  const json = /\{[\s\S]*\}/.exec(texto)?.[0];
  if (!json) return null;
  try {
    const r = respostaDoModelo.safeParse(JSON.parse(json));
    return r.success && r.data.endereco && valorAceitavel("endereco", r.data.endereco) ? r.data.endereco : null;
  } catch {
    return null;
  }
}

/** A assinatura do leitor de endereço — injetável para teste. */
export type LeitorDeEndereco = (p: { organizationId: string; texto: string }) => Promise<string | null>;

/**
 * O leitor de verdade: o SEAM único de chamada de modelo (`runModelCall`), que
 * grava `llm_calls` (custo na tela de Uso), respeita o teto de gasto da
 * organização e o painel de provedores (ponto `extracao_de_cadastro`). A
 * mensagem vai com todo CPF mascarado — o modelo não precisa dele.
 *
 * Nunca lança: falha do provedor ou orçamento estourado devolvem `null` e o
 * resto da extração (regra fixa) segue. O log não leva o texto.
 */
export const lerEnderecoPeloModelo: LeitorDeEndereco = async ({ organizationId, texto }) => {
  try {
    const chamada = await runModelCall(getRequestPool(), llmEdgeConfigFromEnv(env), {
      tenantId: organizationId,
      purpose: "extracao_de_cadastro",
      reasoning: "none",
      system: INSTRUCAO_DO_ENDERECO,
      messages: [{ role: "user", content: mascararCpfsNoTexto(texto).slice(0, 1500) }],
    });
    return lerRespostaDoEndereco(chamada.result.text);
  } catch (err) {
    logger.warn("[extracao-silenciosa] leitura do endereço falhou — segue sem ele", {
      organization_id: organizationId,
      // Só o tipo do erro: a mensagem de parse pode trazer pedaço do endereço.
      erro: err instanceof Error ? err.name : "desconhecido",
    });
    return null;
  }
};

// ===========================================================================
// I/O
// ===========================================================================

export type ResultadoDaExtracao =
  | { status: "ignorado"; motivo: string }
  | { status: "lido"; preenchidos: CampoExtraido[]; propostos: CampoExtraido[] };

interface Contato {
  id: string;
  is_blocked: boolean | null;
  is_anonymized: boolean | null;
  is_merged_into: string | null;
  force_human: boolean | null;
  email: string | null;
  birthdate: string | null;
  cpf_hash: string | null;
  custom_fields: Record<string, unknown> | null;
  consent: Record<string, unknown> | null;
}

/**
 * Lê UMA mensagem inbound e aplica a regra. `db` é o client de SERVIÇO: toda
 * consulta filtra `organization_id`, que vem da linha confiável do
 * `event_log`, nunca do conteúdo da mensagem.
 */
export async function extrairCadastroSilencioso(
  db: SupabaseClient,
  entrada: { organizationId: string; messageId: string },
  deps: { lerEndereco?: LeitorDeEndereco; agora?: Date } = {},
): Promise<ResultadoDaExtracao> {
  const { organizationId: org, messageId } = entrada;
  const agora = deps.agora ?? new Date();
  const lerEndereco = deps.lerEndereco ?? lerEnderecoPeloModelo;

  // 1. O interruptor primeiro: é o desfecho mais comum e o mais barato.
  const { data: organizacao, error: erroOrg } = await db
    .from("organizations")
    .select("settings")
    .eq("id", org)
    .maybeSingle();
  if (erroOrg || !organizacao) return { status: "ignorado", motivo: "interruptor_ilegivel" };
  if (!extracaoSilenciosaLigada((organizacao as { settings?: unknown }).settings)) {
    return { status: "ignorado", motivo: "desligada" };
  }

  // 2. A mensagem.
  const { data: msg, error: erroMsg } = await db
    .from("messages")
    .select("id, body, direction, conversation_id, created_at")
    .eq("id", messageId)
    .eq("organization_id", org)
    .maybeSingle();
  if (erroMsg) throw new Error(`mensagem: ${erroMsg.message}`);
  const m = msg as { body: string | null; direction: string; conversation_id: string; created_at: string } | null;
  if (!m) return { status: "ignorado", motivo: "mensagem_nao_encontrada" };
  if (m.direction !== "inbound") return { status: "ignorado", motivo: "nao_inbound" };
  const texto = (m.body ?? "").trim();
  if (!texto) return { status: "ignorado", motivo: "sem_texto" };

  // 3. A conversa e o contato.
  const { data: conv, error: erroConv } = await db
    .from("conversations")
    .select(
      "id, contact_id, is_group, bot_silenced_until, assignee_kind, contacts:contact_id(id, is_blocked, is_anonymized, is_merged_into, force_human, email, birthdate, cpf_hash, custom_fields, consent)",
    )
    .eq("id", m.conversation_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (erroConv) throw new Error(`conversa: ${erroConv.message}`);
  const c = conv as {
    id: string;
    is_group: boolean | null;
    bot_silenced_until: string | null;
    assignee_kind: string | null;
    contacts: Contato | null;
  } | null;
  if (!c || !c.contacts) return { status: "ignorado", motivo: "conversa_nao_encontrada" };
  if (c.is_group === true) return { status: "ignorado", motivo: "grupo" };
  const contato = c.contacts;
  if (contato.is_blocked === true) return { status: "ignorado", motivo: "contato_bloqueado" };
  if (contato.is_anonymized === true) return { status: "ignorado", motivo: "contato_anonimizado" };
  if (contato.is_merged_into) return { status: "ignorado", motivo: "contato_juntado" };
  if (!conversaDaEquipe(c, contato, agora)) return { status: "ignorado", motivo: "conversa_com_ia" };

  // 4. Idempotência: esta mensagem já deixou rastro? (O banco segura o resto:
  // "ainda vazio" no UPDATE e o índice único de proposta pendente.)
  const { data: rastro, error: erroRastro } = await db
    .from("api_audit_log")
    .select("id")
    .eq("organization_id", org)
    .eq("resource_type", "contact")
    .eq("resource_id", contato.id)
    .in("action", ["contact.field_auto_applied", "contact.field_proposed"])
    .eq("metadata->>message_id", messageId)
    .limit(1);
  if (erroRastro) throw new Error(`rastro: ${erroRastro.message}`);
  if ((rastro ?? []).length > 0) return { status: "ignorado", motivo: "ja_lida" };

  // 5. O que a mensagem traz. O pedido da equipe logo antes ("me manda seu
  // CPF") é o contexto que torna "123..." ou "10/03/90" um dado de cadastro.
  const { data: anterior } = await db
    .from("messages")
    .select("body")
    .eq("organization_id", org)
    .eq("conversation_id", c.id)
    .eq("direction", "outbound")
    .lt("created_at", m.created_at)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const contexto = typeof (anterior as { body?: unknown } | null)?.body === "string" ? (anterior as { body: string }).body : "";
  const achados: Partial<Record<CampoExtraido, string>> = extrairDeterministico(texto, agora, contexto);
  if (temIndicioDeEndereco(texto)) {
    const endereco = await lerEndereco({ organizationId: org, texto });
    if (endereco) achados.endereco = endereco;
  }
  const campos = (Object.keys(achados) as CampoExtraido[]).filter((k) => achados[k]);
  if (campos.length === 0) return { status: "lido", preenchidos: [], propostos: [] };

  const consentimento = {
    ...(contato.consent ?? {}),
    transactional: {
      granted: true,
      granted_at: agora.toISOString(),
      source: "informado pelo titular em atendimento; aplicado automaticamente sem decisão humana",
    },
  };
  const trilha = { origem: ORIGEM, message_id: messageId, conversation_id: c.id };
  const preenchidos: CampoExtraido[] = [];
  const propostos: CampoExtraido[] = [];

  for (const campo of campos) {
    const valor = achados[campo]!;
    const acao = await acaoDoCampo(db, campo, valor, contato);
    if (acao === "nada") continue;

    if (acao === "preencher") {
      const gravou = await preencher(db, org, contato, campo, valor, consentimento);
      if (!gravou) continue;
      preenchidos.push(campo);
      await audit({
        action: "contact.field_auto_applied",
        organizationId: org,
        resourceType: "contact",
        resourceId: contato.id,
        // O CAMPO, nunca o valor: a auditoria não é alcançada pela anonimização.
        metadata: {
          actor_type: "system",
          campo,
          automatico: true,
          ...trilha,
          legal_basis: "L-05 transactional (dado informado pelo titular em atendimento iniciado por ele)",
        },
      });
      await registrarDadoAplicadoNaTimeline(db, {
        organizationId: org,
        contactId: contato.id,
        reason: `${NOME[campo]} informado pelo cliente gravado na ficha (conversa atendida pela equipe)`,
        payload: { campo, automatico: true, ...trilha },
      });
      continue;
    }

    const r = await proporDadoDoContato(db, {
      organizationId: org,
      contactId: contato.id,
      campo,
      valor,
      trecho: texto.slice(0, 500),
      conversationId: c.id,
      messageId,
    });
    if (!r.criada) continue;
    propostos.push(campo);
    await audit({
      action: "contact.field_proposed",
      organizationId: org,
      resourceType: "contact",
      resourceId: contato.id,
      metadata: { actor_type: "system", proposal_id: r.id, campo, ...trilha },
    });
  }

  if (propostos.length > 0) await avisarDivergencia(db, org, contato.id, propostos);

  logger.info("[extracao-silenciosa] mensagem lida", {
    organization_id: org,
    message_id: messageId,
    preenchidos,
    propostos,
  });
  return { status: "lido", preenchidos, propostos };
}

async function acaoDoCampo(
  db: SupabaseClient,
  campo: CampoExtraido,
  valor: string,
  contato: Contato,
): Promise<Acao> {
  if (campo === "cpf") {
    if (!contato.cpf_hash) return "preencher";
    const indice = await indiceDoCpf(db, valor);
    // Sem índice não há como comparar: nada a fazer agora (e nada exposto).
    if (!indice) return "nada";
    return decidir(contato.cpf_hash, indice === contato.cpf_hash);
  }
  if (campo === "endereco") {
    const atual = enderecoDaFicha(contato.custom_fields);
    return decidir(atual, atual !== null && enderecoComparavel(atual) === enderecoComparavel(valor));
  }
  const atual = campo === "email" ? contato.email : contato.birthdate;
  return decidir(atual, atual !== null && atual.trim().toLowerCase() === valor);
}

/**
 * Grava UM campo vazio. A trava "ainda vazio" vai DENTRO do UPDATE: se alguém
 * preencheu entre a leitura e a escrita, nada é sobrescrito. Valor que já é de
 * outro contato (índice único de e-mail/CPF → 23505) também não grava.
 *
 * @returns `true` só quando UMA linha foi gravada.
 */
async function preencher(
  db: SupabaseClient,
  org: string,
  contato: Contato,
  campo: CampoExtraido,
  valor: string,
  consent: Record<string, unknown>,
): Promise<boolean> {
  let patch: Record<string, unknown>;
  let coluna: string;
  if (campo === "cpf") {
    const par = await parDoCpf(db, valor);
    if (!par) return false;
    patch = { ...par };
    coluna = "cpf_hash";
  } else if (campo === "endereco") {
    patch = { custom_fields: { ...(contato.custom_fields ?? {}), endereco: valor } };
    coluna = "custom_fields->>endereco";
  } else {
    patch = { [campo]: valor };
    coluna = campo;
  }

  const { data, error } = await db
    .from("contacts")
    .update({ ...patch, consent })
    .eq("organization_id", org)
    .eq("id", contato.id)
    .eq("is_anonymized", false)
    .is(coluna, null)
    .select("id");
  if (error) {
    logger.warn("[extracao-silenciosa] campo não gravado", {
      organization_id: org,
      contact_id: contato.id,
      campo,
      code: (error as { code?: string }).code ?? null,
    });
    return false;
  }
  return Array.isArray(data) && data.length === 1;
}

/**
 * UM aviso aberto por contato: se já há um, ele basta — aviso que se repete a
 * cada mensagem é o ruído que faz a Central ser ignorada. O texto diz QUAIS
 * campos, nunca os valores: o aviso é lido por quem talvez não devesse vê-los.
 */
async function avisarDivergencia(
  db: SupabaseClient,
  org: string,
  contactId: string,
  campos: CampoExtraido[],
): Promise<void> {
  const { data: aberto } = await db
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", org)
    .eq("kind", "contact_data_divergent")
    .eq("ref_kind", "contact")
    .eq("ref_id", contactId)
    .eq("status", "open")
    .limit(1);
  if ((aberto ?? []).length > 0) return;

  const lista = campos.map((k) => NOME[k].toLowerCase()).join(", ");
  const { error } = await db.from("agent_inbox_items").insert({
    organization_id: org,
    kind: "contact_data_divergent",
    severity: "info",
    title: "Um cliente informou um dado diferente do cadastro",
    body:
      `Na conversa atendida pela equipe, o cliente informou ${lista} diferente do que está na ficha. ` +
      "Nada foi trocado: confira a sugestão na ficha do contato e confirme ou recuse.",
    ref_kind: "contact",
    ref_id: contactId,
  });
  if (error) {
    logger.warn("[extracao-silenciosa] aviso de divergência não aberto", {
      organization_id: org,
      contact_id: contactId,
      erro: error.message,
    });
  }
}
