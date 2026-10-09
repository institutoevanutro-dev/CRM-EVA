/**
 * Os MODELOS DE MENSAGEM — as respostas prontas que a empresa já escreveu
 * (`message_templates`).
 *
 * ⚠️ PREENCHER NÃO É ENVIAR, e a separação é o ponto. Enviar é
 * `crm_send_whatsapp_message`, classificada `critico` porque o cliente recebe de
 * verdade no celular dele. Preencher só devolve TEXTO: quem lê decide o que
 * fazer com ele. Juntar as duas coisas numa capacidade só faria "usar o modelo
 * de boas-vindas" carregar, escondido, o direito de falar com o cliente.
 *
 * ⚠️ O MODELO É DA EMPRESA, O AGENTE NÃO ESCREVE UM NOVO. Um modelo é texto
 * revisado por gente para sair em nome da marca; deixar o agente criar modelo
 * seria deixá-lo publicar a própria voz como se fosse a da empresa, e nenhuma
 * tela hoje distingue um do outro. Escrever mensagem o agente já sabe — o que
 * ele ganha aqui é PARAR de inventar quando a empresa já decidiu como diz.
 *
 * ⚠️ A LISTA NÃO TRAZ O PESSOAL DE TODO MUNDO, e a régua NÃO foi inventada
 * aqui: é a policy `message_templates_select` (migration 0060). Um membro lê o
 * compartilhado (`owner_user_id is null`) **mais o próprio**. A tela e a rota
 * REST herdam esse predicado da RLS; a tool usa o client **service role**, que
 * bypassa a policy, e por isso listava os rascunhos pessoais de cada atendente
 * para qualquer token de integração e para a IA. O `eq("organization_id", …)`
 * não bastava: o vazamento era dentro da mesma empresa. Porte de
 * melgarafael/DeskcommCRM #1673 (9f566e7f58), só o núcleo de visibilidade.
 */
import { ApiError } from "@/lib/api/types";
import { renderTemplate } from "@/lib/automation/template";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";

export interface ModeloVisivel {
  id: string;
  titulo: string;
  corpo: string;
  atalho: string | null;
  /** `true` = da empresa inteira; `false` = pessoal de quem o criou. */
  compartilhado: boolean;
}

export interface OpcoesDosModelos {
  /** O pessoal só entra com isto ligado **e** com um dono de verdade (uma pessoa). */
  incluirPessoais?: boolean;
}

export async function listarModelosDeMensagem(
  deps: DepsDaOperacao,
  opts: OpcoesDosModelos = {},
): Promise<ModeloVisivel[]> {
  // `actor.id` de um token é o id do TOKEN (ou o do run do agente) e nunca casa
  // com um `owner_user_id`: um token não tem rascunho pessoal.
  const dono = deps.actor.type === "user" ? deps.actor.id : null;
  const incluirPessoais = opts.incluirPessoais === true && dono !== null;

  const { data, error } = await visivelPara(
    deps.supabase
      .from("message_templates")
      .select("id, title, body, shortcut, owner_user_id")
      .eq("organization_id", deps.organizationId),
    incluirPessoais ? dono : null,
  ).order("updated_at", { ascending: false });
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((t) => ({
    id: t.id as string,
    titulo: t.title as string,
    corpo: t.body as string,
    atalho: (t.shortcut as string | null) ?? null,
    compartilhado: t.owner_user_id === null,
  }));
}

/**
 * A régua da policy `message_templates_select`, em SQL e não em memória: o
 * compartilhado sempre, o pessoal só do `dono` (e nenhum quando `dono` é null).
 */
function visivelPara<C extends { or(filtro: string): C; is(coluna: string, valor: null): C }>(
  consulta: C,
  dono: string | null,
): C {
  return dono === null
    ? consulta.is("owner_user_id", null)
    : consulta.or(`owner_user_id.is.null,owner_user_id.eq.${dono}`);
}

export interface ModeloPreenchido {
  id: string;
  titulo: string;
  texto: string;
  /** As marcações que ficaram sem valor — quem lê precisa saber antes de mandar. */
  lacunas: string[];
}

/**
 * O modelo com os dados do cliente no lugar das marcações.
 *
 * ⚠️ AS LACUNAS SÃO DEVOLVIDAS, NÃO ESCONDIDAS. `renderTemplate` troca marcação
 * sem valor por string vazia, o que produz "Olá , tudo bem?" — uma frase que
 * parece pronta e sai errada. Dizer QUAIS ficaram vazias é o que permite a quem
 * lê decidir entre completar, escolher outro modelo, ou escrever à mão. Uma
 * função que só devolvesse o texto empurraria esse defeito para o cliente final.
 */
export async function preencherModeloDeMensagem(
  deps: DepsDaOperacao,
  input: { templateId: string; contactId?: string; leadId?: string },
): Promise<ModeloPreenchido> {
  // A MESMA régua da lista: sem ela, um id de modelo pessoal alheio abria o
  // corpo pelo preenchimento. Fora da régua cai no 404 abaixo, que não diz se
  // o modelo existe.
  const { data: modelo, error } = await visivelPara(
    deps.supabase
      .from("message_templates")
      .select("id, title, body")
      .eq("id", input.templateId)
      .eq("organization_id", deps.organizationId),
    deps.actor.type === "user" ? deps.actor.id : null,
  ).maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);
  if (!modelo) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      deps.requestId,
      "Essa resposta pronta não existe aqui.",
    );
  }

  const contexto = await montarContexto(deps, input);
  const corpo = (modelo as unknown as { body: string }).body;

  return {
    id: (modelo as unknown as { id: string }).id,
    titulo: (modelo as unknown as { title: string }).title,
    texto: renderTemplate(corpo, contexto),
    lacunas: lacunasDe(corpo, contexto),
  };
}

/**
 * O contexto do preenchimento: o contato e o negócio, nada além.
 *
 * O `contact_id` do negócio é usado quando só o negócio foi informado — quem
 * pede "preencha para este negócio" espera o nome do cliente dele, não uma
 * lacuna.
 */
async function montarContexto(
  deps: DepsDaOperacao,
  input: { contactId?: string; leadId?: string },
): Promise<Record<string, unknown>> {
  const contexto: Record<string, unknown> = {};

  let contactId = input.contactId ?? null;

  if (input.leadId) {
    const { data: lead } = await deps.supabase
      .from("crm_leads")
      .select("id, title, value_cents, currency, contact_id")
      .eq("id", input.leadId)
      .eq("organization_id", deps.organizationId)
      .maybeSingle();
    if (lead) {
      contexto.lead = lead;
      contactId = contactId ?? ((lead as unknown as { contact_id: string | null }).contact_id ?? null);
    }
  }

  if (contactId) {
    const { data: contato } = await deps.supabase
      .from("contacts")
      .select("id, name, phone_number, email")
      .eq("id", contactId)
      .eq("organization_id", deps.organizationId)
      .maybeSingle();
    if (contato) contexto.contact = contato;
  }

  return contexto;
}

/**
 * O contato dono de um negócio desta organização, ou `null` — negócio que não
 * existe aqui e negócio sem contato dão o MESMO `null`, de propósito: quem
 * compara com o contato do turno não deve conseguir distinguir os dois.
 */
export async function contatoDoNegocio(
  deps: DepsDaOperacao,
  leadId: string,
): Promise<string | null> {
  const { data, error } = await deps.supabase
    .from("crm_leads")
    .select("contact_id")
    .eq("id", leadId)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);
  return (data as { contact_id: string | null } | null)?.contact_id ?? null;
}

/** As marcações do modelo que o contexto não resolveu — mesma varredura do render. */
function lacunasDe(template: string, contexto: Record<string, unknown>): string[] {
  const vazias = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const marcacao = m[1]!;
    // Comparar o render de UMA marcação isolada é o que garante a mesma régua
    // do texto final: alias, caminho aninhado e ausência passam pelo mesmo código.
    if (renderTemplate(`{{${marcacao}}}`, contexto) === "") vazias.add(marcacao);
  }
  return [...vazias];
}
