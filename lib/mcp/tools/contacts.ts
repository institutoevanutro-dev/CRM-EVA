/**
 * MCP read tools sobre /api/v1/contacts (Spec 11 §3.1).
 *
 * Wrappa os handlers REST extraidos na wave 2 (S-13.02). O MCP server core
 * injeta `ctx.supabase` (admin client + service-role) e `ctx.organizationId`
 * — handlers ja aplicam `.eq('organization_id', ctx.organization_id)` em
 * defesa-em-profundidade pos wave 3 (RLS continua valida quando ctx vem
 * de cookie).
 */
import { z } from "zod";

import {
  listContactsHandler,
  getContactHandler,
} from "@/app/api/v1/contacts/_handler";
import type { McpToolDefinition } from "../types";
import { foraDaConversa } from "../fora-da-conversa";
import { CAMPOS_PROPONIVEIS, proporDadoDoContato } from "@/lib/contacts/proposta-de-dado";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { audit } from "@/lib/audit";

const searchInputShape = {
  query: z.string().min(1).max(200).describe("Termo de busca (nome, email ou telefone)."),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
};

export const crmSearchContacts: McpToolDefinition<typeof searchInputShape> = {
  name: "crm_search_contacts",
  description:
    "Busca contatos do CRM por nome, email ou telefone. Retorna ate 50 matches com id, nome, telefone, email, tags e timestamps. Sempre escopado a organization do token." +
    " Em conversa de atendimento, devolve apenas o contato desta conversa.",
  inputSchema: searchInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── A CONVERSA É COM ALGUÉM ─────────────────────────────────────────────
    //
    // Num atendimento com o paciente A, o modelo buscava "Maria" e recebia a
    // ficha da paciente B — telefone e e-mail numa resposta só, `success: true`
    // no audit, e o dado saindo no WhatsApp do outro lado, encaminhável, sem
    // volta. ESCOPO, e não tradução: o termo continua sendo o que o modelo
    // digitou; muda só QUEM a resposta alcança. O escopo vai NA CONSULTA, antes
    // do limite (filtrar a página depois devolvia vazio quando o contato do
    // turno não estava entre os primeiros), e de novo na resposta, como cinto.
    //
    // `ctx.contatoDoTurno` é contexto de CONFIANÇA, injetado pelo runtime. Sem
    // ele (rota HTTP, MCP externo, token de integração), a busca segue
    // alcançando a base da organização, exatamente como antes. A paginação
    // morre junto: `cursor`/`has_more` descrevem a varredura da organização.
    const doTurno = ctx.contatoDoTurno;
    const result = await listContactsHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      {
        search: input.query,
        limit: input.limit,
        cursor: input.cursor,
      },
      doTurno,
    );
    const visiveis = doTurno ? result.contacts.filter((c) => c.id === doTurno) : result.contacts;
    return {
      contacts: visiveis.map((c) => ({
        id: c.id,
        name: nomeDoContato(c),
        phone: c.phone_number,
        email: c.email,
        tags: c.tags ?? [],
        is_blocked: c.is_blocked,
        is_anonymized: c.is_anonymized,
        created_at: c.created_at,
        last_activity_at: c.last_activity_at,
      })),
      cursor: doTurno ? null : result.cursor,
      has_more: doTurno ? false : result.has_more,
    };
  },
};

const getInputShape = {
  contact_id: z.string().uuid().describe("UUID do contato."),
};

export const crmGetContact: McpToolDefinition<typeof getInputShape> = {
  name: "crm_get_contact",
  description:
    "Retorna detalhes de um contato pelo UUID. Inclui tags, consent, source. CPF nunca retornado em plaintext via MCP (sempre mascarado)." +
    " Em conversa de atendimento, devolve a ficha do contato desta conversa.",
  inputSchema: getInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── A FICHA DE QUEM NÃO É DESTA CONVERSA NÃO ABRE AQUI ──────────────────
    //
    // RECUSA, e não tradução: trocar o uuid pedido pelo do contato do turno
    // faria o modelo perguntar por um paciente e receber outro. O motivo vem em
    // TEXTO, na mesma forma da recusa de escrita, e a ponte o audita como
    // recusa (`contato_da_conversa:fora_da_conversa`). Sem contato do turno,
    // a ficha de qualquer contato da organização segue abrindo como antes.
    if (ctx.contatoDoTurno && input.contact_id !== ctx.contatoDoTurno) {
      return foraDaConversa("a ficha de quem não é o paciente desta conversa não é sua para abrir");
    }
    const contact = await getContactHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      { contactId: input.contact_id, decryptPurpose: null },
    );
    return {
      id: contact.id,
      name: contact.name,
      display_name: contact.display_name,
      email: contact.email,
      phone: contact.phone_number,
      tags: contact.tags ?? [],
      source: contact.source,
      consent: contact.consent ?? {},
      is_blocked: contact.is_blocked,
      is_anonymized: contact.is_anonymized,
      cpf_available: contact.cpf_available,
      created_at: contact.created_at,
      last_activity_at: contact.last_activity_at,
    };
  },
};

// ---------------------------------------------------------------------------
// crm_propose_contact_field — o dado que o cliente disse, PROPOSTO
// ---------------------------------------------------------------------------

const propostaShape = {
  contact_id: z.string().uuid(),
  campo: z
    .enum(CAMPOS_PROPONIVEIS)
    .describe("Qual informação: email, name, phone_number ou birthdate (AAAA-MM-DD)."),
  valor: z.string().min(1).max(200).describe("O valor exatamente como a pessoa informou."),
  trecho: z
    .string()
    .max(500)
    .optional()
    .describe("O que a pessoa escreveu, para quem for confirmar poder conferir."),
};

/**
 * ⚠️ Esta ferramenta NÃO grava o dado — com UMA exceção condicionada (#2593): o
 * TELEFONE de um contato SEM número é gravado na hora, em E.164, com auditoria e
 * rastro na linha do tempo, MAS SÓ quando a organização liga a opção
 * `settings.crm.telefone_de_ficha_vazia` (desligada por padrão). Nos demais
 * casos ela cria uma proposta que uma pessoa confirma, e o `description` diz as
 * DUAS coisas ao modelo em primeiro lugar, de propósito: um modelo que acredite
 * ter gravado responderia "pronto, já atualizei seu cadastro" ao cliente,
 * prometendo o que não aconteceu — e um que ache que nunca grava nada
 * responderia "vou anotar para alguém confirmar" num caso em que o número já
 * entrou na ficha.
 *
 * ⚠️ O TEXTO NÃO PROMETE A GRAVAÇÃO: como a opção é POR ORGANIZAÇÃO e desligada
 * por padrão, quem lê a ferramenta não pode decidir antes de chamá-la se o
 * desfecho foi escrita ou fila — quem responde isso é o RETORNO
 * (`motivo: "aplicado_automaticamente"`). Por isso o corpo diz "pode ser
 * gravado" e o `mensagem` do desfecho aplicado é quem autoriza o modelo a dizer
 * ao cliente que ficou anotado.
 *
 * Ela é de CATÁLOGO, e não nativa do Operador, porque o Operador não monta
 * ToolSet nativo nenhum (zero ocorrências de `tool(` em operator-turn.ts) e só
 * chama o modelo quando há MCP. Uma nativa não apareceria na tela que liga
 * capacidades, não entraria no audit `mcp.tool_called` e sumiria da telemetria
 * de uso — nasceria invisível ao invariante 3 do sistema vivo.
 */
export const crmProposeContactField: McpToolDefinition<typeof propostaShape> = {
  name: "crm_propose_contact_field",
  description:
    "Registra uma informação que o cliente forneceu (email, nome, telefone ou data de nascimento) como PROPOSTA para " +
    "uma pessoa confirmar; a proposta vence sozinha se ninguém decidir. EXCEÇÃO: um TELEFONE informado para um " +
    "contato que está SEM número pode ser gravado NA HORA, em formato internacional E.164 — mas só quando a " +
    "organização liga essa opção (vem desligada), e quem diz se a gravação aconteceu é o RETORNO desta chamada " +
    "(motivo \"aplicado_automaticamente\"); sem esse motivo, diga que alguém vai conferir. Nunca é gravado: telefone de " +
    "quem JÁ tem número no cadastro (trocar exige decisão humana), email, nome e data de nascimento — para esses nunca " +
    "diga que o cadastro foi atualizado. Recusa se já houver proposta do mesmo campo aguardando decisão, se o valor for " +
    "igual ao que já está gravado, ou se o contato foi anonimizado.",
  inputSchema: propostaShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const r = await proporDadoDoContato(ctx.supabase, {
      organizationId: ctx.organizationId,
      contactId: input.contact_id,
      campo: input.campo,
      valor: input.valor,
      trecho: input.trecho ?? null,
      // ⚠️ `agent_id`, NUNCA `actor.id`: a coluna `crm_lead_activities.actor_agent_id`
      // tem FK para `ai_agents`, e `actor.id` carrega o id do RUN (ou o do
      // token, ou a string `agent-engine` dependendo do runtime). Sem
      // `agent_id` a linha entra como sistema — perde-se a AUTORIA do rastro,
      // que é ruim, em vez da linha inteira, que é pior. Ver `Actor` em
      // `lib/api/handlers/types.ts`.
      agentId: ctx.actor.type === "ai_agent" ? (ctx.actor.agent_id ?? null) : null,
    });

    // Mesmo payload de ator das outras tools de escrita. Inline porque
    // `retencao.ts` mantém o dele local — extrair para um módulo comum tocaria
    // um arquivo alheio sem que este trabalho peça isso. Subiu para cima do
    // `if` porque o desfecho APLICADO também audita (#2593) e é o mesmo ator.
    const a =
      ctx.actor.type === "user"
        ? { actorUserId: ctx.actor.id as string | null, metadataActor: { actor_type: "user" } }
        : { actorUserId: null, metadataActor: { actor_type: ctx.actor.type, actor_id: ctx.actor.id } };

    if (!r.criada) {
      // ── #2593: o telefone de ficha vazia JÁ ESTÁ na ficha ──────────────────
      //
      // Este é o ÚNICO desfecho em que a mensagem pode ser repetida ao
      // cliente — ele aconteceu de verdade. Os de baixo continuam sendo do
      // fluxo interno, para o modelo decidir o que fazer em seguida.
      if (r.motivo === "aplicado_automaticamente") {
        await audit({
          action: "contact.field_auto_applied",
          actorUserId: a.actorUserId,
          organizationId: ctx.organizationId,
          resourceType: "contact",
          resourceId: input.contact_id,
          requestId: ctx.requestId,
          // Quem aplicou, quando e o par antes/depois da L-06 — SEM o `trecho`.
          // A auditoria não é alcançada pela anonimização (só sai pela retenção),
          // e o trecho é texto livre do cliente: numa clínica pode trazer dado de
          // saúde. Ele vai para a linha da timeline, que a cascata da LGPD limpa
          // (`registrarTelefoneAplicadoNaTimeline`).
          metadata: {
            ...a.metadataActor,
            campo: input.campo,
            old_value: null,
            new_value: r.telefone,
            automatico: true,
            legal_basis: "L-05 transactional (dado informado pelo titular em atendimento iniciado por ele)",
          },
        });
        return {
          proposta_criada: false,
          motivo: r.motivo,
          telefone: r.telefone,
          mensagem:
            "este contato estava SEM telefone e o número que a pessoa informou foi GRAVADO no cadastro, " +
            `em formato internacional (${r.telefone}); pode dizer ao cliente que ficou anotado. ` +
            "Um número que já existia no cadastro nunca é substituído por esta chamada.",
        };
      }

      // As mensagens são para o MODELO decidir o que fazer em seguida — e
      // nenhuma delas é para repetir ao cliente. Falam do fluxo interno, não do
      // atendimento.
      const explicacao: Record<string, string> = {
        contato_nao_encontrado: "não encontrei esse contato nesta conta.",
        contato_anonimizado:
          "esse contato exerceu o direito de exclusão de dados; não é possível registrar informações dele.",
        valor_invalido:
          "o valor não tem forma de email/telefone/nome/data de nascimento válidos — confirme com a pessoa.",
        valor_igual_ao_atual: "essa informação já está no cadastro; não há o que confirmar.",
        ja_existe_proposta:
          "já existe uma proposta desse mesmo campo aguardando decisão de uma pessoa — não crie outra.",
        erro: "não consegui registrar a proposta agora.",
      };
      return { proposta_criada: false, motivo: r.motivo, mensagem: explicacao[r.motivo] };
    }

    await audit({
      action: "contact.field_proposed",
      actorUserId: a.actorUserId,
      organizationId: ctx.organizationId,
      resourceType: "contact",
      resourceId: input.contact_id,
      requestId: ctx.requestId,
      // A proposta é uma intenção auditável mesmo que nunca vire escrita. O
      // par antes/depois NÃO entra: nome, e-mail e telefone numa trilha
      // imutável sobreviveriam ao pedido de exclusão do titular (achado A6).
      // O valor proposto já mora na própria proposta (`proposal_id`).
      metadata: { ...a.metadataActor, proposal_id: r.id, campo: input.campo },
    });

    return {
      proposta_criada: true,
      proposta_id: r.id,
      campo: input.campo,
      aguardando: "confirmação de uma pessoa",
    };
  },
};
