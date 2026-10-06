import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { collectExportData } from "@/lib/lgpd/export-collector";

/**
 * O RELATÓRIO DO TITULAR: o que entra, de quem, e o que não pode sair.
 *
 * `tests/unit/lgpd-exporta-o-que-redige.test.ts` prova que a TABELA é visitada.
 * Aqui se prova o recorte de cada bloco acrescentado junto com a migration 0317
 * (comentários do Instagram, caso da IA, demanda, avisos) e dos campos
 * personalizados e propostas da IA: o que entra é do titular (e só dele), e o
 * CPF guardado em campo personalizado não sai em claro.
 */

type Row = Record<string, unknown>;
const ORG = "org-a";
const OUTRA_ORG = "org-b";
const TITULAR = "contato-a";
const pedido = { organizationId: ORG, requestId: "pedido-0317", contactId: TITULAR, externalCustomerId: null };
let rows: Record<string, Row[]>;
const leituras: { tabela: string; pagina: [number, number] }[] = [];

/** PostgREST de mentira: aplica `eq`, `in`, `range` e devolve só as colunas pedidas. */
class Consulta {
  colunas = "";
  filtros: [string, unknown][] = [];
  dentro: [string, unknown[]][] = [];
  pagina: [number, number] = [0, 999];
  constructor(readonly tabela: string) {}
  select(colunas: string) {
    this.colunas = colunas;
    return this;
  }
  eq(coluna: string, valor: unknown) {
    this.filtros.push([coluna, valor]);
    return this;
  }
  in(coluna: string, valores: unknown[]) {
    this.dentro.push([coluna, valores]);
    return this;
  }
  not() {
    return this;
  }
  order() {
    return this;
  }
  or() {
    return this;
  }
  limit(n: number) {
    this.pagina = [0, n - 1];
    return this;
  }
  range(de: number, ate: number) {
    this.pagina = [de, ate];
    return this;
  }
  async maybeSingle() {
    const r = await this.executar();
    return { ...r, data: r.data[0] ?? null };
  }
  then(ok: (r: unknown) => unknown, falha?: (e: unknown) => unknown) {
    return this.executar().then(ok, falha);
  }
  async executar() {
    leituras.push({ tabela: this.tabela, pagina: this.pagina });
    const data = (rows[this.tabela] ?? [])
      .filter((l) => this.filtros.every(([c, v]) => l[c] === v))
      .filter((l) => this.dentro.every(([c, vs]) => vs.includes(l[c])))
      .slice(this.pagina[0], this.pagina[1] + 1)
      .map((l) =>
        this.colunas === "*" || this.colunas === ""
          ? l
          : Object.fromEntries(this.colunas.split(",").map((c) => [c.trim(), l[c.trim()]])),
      );
    return { data, error: null, count: data.length };
  }
}

beforeEach(() => {
  leituras.length = 0;
  rows = {
    organizations: [{ id: ORG, legal_name: "Clínica Exemplo LTDA", display_name: "Clínica Exemplo", dpo_email: null }],
    contacts: [{ id: TITULAR, organization_id: ORG, name: "Joana Teste", created_at: "2026-09-01T00:00:00Z" }],
  };
  mock.admin.mockReturnValue({ from: (tabela: string) => new Consulta(tabela) });
});

describe("LGPD export: comentários do Instagram do titular (0317)", () => {
  const comentario = (id: string, over: Row): Row => ({
    id,
    organization_id: ORG,
    contact_id: null,
    media_id: "post-1",
    texto: `texto de ${id}`,
    autor_igsid: "IGSID-DA-JOANA",
    autor_handle: "joana.teste",
    comentado_em: "2026-09-10T00:00:00Z",
    situacao: "esperando_voce",
    sugestao_de_resposta: null,
    motivo_do_toque: null,
    ...over,
  });

  it("entra o que é dela — pelo IGSID da identidade ou pelo vínculo —, uma vez só, e nada de mais ninguém", async () => {
    rows.contact_channel_identities = [
      { id: "ident-1", organization_id: ORG, contact_id: TITULAR, channel: "instagram", external_id: "IGSID-DA-JOANA", handle: "joana.teste" },
    ];
    rows.instagram_comments = [
      comentario("pelo-igsid", {}),
      // Achado pelos DOIS braços: tem de sair uma vez.
      comentario("pelos-dois", { contact_id: TITULAR }),
      comentario("so-pelo-vinculo", { contact_id: TITULAR, autor_igsid: "OUTRO-IGSID-DELA" }),
      comentario("de-outra-pessoa", { autor_igsid: "IGSID-DO-PEDRO", autor_handle: "pedro" }),
      comentario("de-outra-org", { organization_id: OUTRA_ORG }),
    ];

    const payload = await collectExportData(pedido);

    expect((payload.instagram_comments ?? []).map((c) => c.id).sort()).toEqual([
      "pelo-igsid",
      "pelos-dois",
      "so-pelo-vinculo",
    ]);
    expect(payload.instagram_comments?.[0]).toMatchObject({ media_id: "post-1", autor_handle: "joana.teste" });
    // O IGSID não se repete em cada comentário: já está em `channel_identities`.
    expect(JSON.stringify(payload.instagram_comments)).not.toContain("IGSID-DA-JOANA");
  });

  it("identidade já anonimizada não tem IGSID: a marca `anonimizado:` não vira filtro", async () => {
    rows.contact_channel_identities = [
      { id: "ident-1", organization_id: ORG, contact_id: TITULAR, channel: "instagram", external_id: "anonimizado:ident-1", handle: null },
    ];
    rows.instagram_comments = [comentario("anonimo-de-outro", { autor_igsid: "anonimizado" })];

    const payload = await collectExportData(pedido);

    expect(payload.instagram_comments).toEqual([]);
  });
});

describe("LGPD export: o caso que a IA abriu, a demanda e os avisos (0317)", () => {
  const CONVERSA = "conversa-da-joana";
  const CONVERSA_ALHEIA = "conversa-do-pedro";

  beforeEach(() => {
    rows.conversations = [
      { id: CONVERSA, organization_id: ORG, contact_id: TITULAR, status: "open", channel: "whatsapp" },
      { id: CONVERSA_ALHEIA, organization_id: ORG, contact_id: "contato-b", status: "open", channel: "whatsapp" },
    ];
    rows.agent_cases = [
      { id: "caso-dela", organization_id: ORG, conversation_id: CONVERSA, status: "awaiting_human", title: "Estorno da Joana", summary: "Joana pagou duas vezes", blocker: "Falta o comprovante", source: "agent", context_snapshot: { recorte: "NAO-EXPORTAR" } },
      { id: "caso-do-pedro", organization_id: ORG, conversation_id: CONVERSA_ALHEIA, status: "awaiting_human", title: "Troca do Pedro", summary: "Pedro quer trocar", blocker: "Falta o pedido", source: "agent" },
      { id: "caso-de-outra-org", organization_id: OUTRA_ORG, conversation_id: CONVERSA, status: "awaiting_human", title: "Outra org", summary: "x", blocker: "y", source: "agent" },
    ];
    rows.agent_case_events = [
      { id: "evento-dela", organization_id: ORG, case_id: "caso-dela", kind: "human_replied", actor_kind: "human", body: "Liguei para a Joana", metadata: {} },
      { id: "evento-do-pedro", organization_id: ORG, case_id: "caso-do-pedro", kind: "human_replied", actor_kind: "human", body: "Liguei para o Pedro", metadata: {} },
    ];
    rows.demandas = [
      { id: "demanda-dela", organization_id: ORG, contact_id: TITULAR, agent_case_id: "caso-dela", origem: "handoff", assunto: "Estorno", estado: "em_atendimento", dono_kind: "humano", proximo_passo: "Ligar para a Joana amanhã" },
      { id: "demanda-do-pedro", organization_id: ORG, contact_id: "contato-b", origem: "inbound", assunto: "Troca", estado: "aberta", dono_kind: "ia", proximo_passo: null },
    ];
    rows.agent_inbox_items = [
      { id: "aviso-pelo-contato", organization_id: ORG, kind: "voice_call_missed", title: "Chamada perdida de +5527999990000", body: "Ninguém atendeu", status: "open", ref_kind: "contact", ref_id: TITULAR },
      { id: "aviso-pela-conversa", organization_id: ORG, kind: "handoff", title: "Assumir a conversa", body: "Resumo: Joana quer estorno", status: "open", ref_kind: "conversation", ref_id: CONVERSA },
      { id: "aviso-pelo-caso", organization_id: ORG, kind: "case_stale", title: "Um atendimento espera decisão", body: "\"Estorno da Joana\" está aguardando", status: "open", ref_kind: "agent_case", ref_id: "caso-dela" },
      { id: "aviso-do-pedro", organization_id: ORG, kind: "case_stale", title: "Um atendimento espera decisão", body: "\"Troca do Pedro\"", status: "open", ref_kind: "agent_case", ref_id: "caso-do-pedro" },
      { id: "aviso-sem-referencia", organization_id: ORG, kind: "qr_rescan", title: "Reconecte o WhatsApp", body: null, status: "open", ref_kind: null, ref_id: null },
    ];
  });

  it("entram os casos das conversas DELA, os eventos desses casos e as demandas dela — de mais ninguém", async () => {
    const payload = await collectExportData(pedido);

    expect(payload.cases?.map((c) => c.id)).toEqual(["caso-dela"]);
    expect(payload.cases?.[0]).toMatchObject({ title: "Estorno da Joana", summary: "Joana pagou duas vezes", blocker: "Falta o comprovante" });
    expect(payload.case_events?.map((e) => e.id)).toEqual(["evento-dela"]);
    expect(payload.demandas?.map((d) => d.id)).toEqual(["demanda-dela"]);
    expect(payload.demandas?.[0]).toMatchObject({ assunto: "Estorno", proximo_passo: "Ligar para a Joana amanhã" });
    const tudo = JSON.stringify(payload);
    expect(tudo).not.toContain("Pedro");
    // O recorte da conversa que foi ao modelo não sai: as mensagens já saem no bloco delas.
    expect(tudo).not.toContain("NAO-EXPORTAR");
  });

  it("entram os avisos que apontam para ela, para a conversa dela ou para o caso dela", async () => {
    const payload = await collectExportData(pedido);

    expect((payload.avisos_da_central ?? []).map((a) => a.id).sort()).toEqual([
      "aviso-pela-conversa",
      "aviso-pelo-caso",
      "aviso-pelo-contato",
    ]);
    expect(payload.avisos_da_central?.find((a) => a.id === "aviso-pelo-contato")?.title).toBe(
      "Chamada perdida de +5527999990000",
    );
  });

  it("titular sem conversa não consulta caso nenhum — `in ()` vazio não vira varredura da tabela", async () => {
    rows.conversations = [];

    const payload = await collectExportData(pedido);

    expect(payload.cases).toEqual([]);
    expect(payload.case_events).toEqual([]);
  });
});

describe("LGPD export: endereço, campos personalizados e propostas da IA", () => {
  // CPF de teste com dígitos verificadores válidos.
  const CPF = "52998224725";

  beforeEach(() => {
    rows.contacts = [
      {
        id: TITULAR,
        organization_id: ORG,
        name: "Joana Teste",
        created_at: "2026-09-01T00:00:00Z",
        custom_fields: {
          endereco: "Rua das Flores, 100 — Vitória/ES",
          convenio: "unimed",
          cpf: CPF,
          observacao: `informou o CPF 529.982.247-25 na recepção`,
        },
      },
    ];
    rows.crm_pipelines = [
      {
        id: "funil-padrao",
        organization_id: ORG,
        is_default: true,
        is_archived: false,
        settings: { fields: [{ key: "convenio", label: "Convênio", type: "select", options: [{ value: "unimed", label: "Unimed Vitória" }] }] },
      },
      // Funil de OUTRA organização com a mesma chave: o rótulo dele não pode vazar.
      {
        id: "funil-alheio",
        organization_id: OUTRA_ORG,
        is_default: true,
        is_archived: false,
        settings: { fields: [{ key: "convenio", label: "ROTULO-DE-OUTRA-ORG", type: "text" }] },
      },
    ];
  });

  it("⭐ o endereço e os campos personalizados saem, com o nome do campo", async () => {
    const payload = await collectExportData(pedido);

    expect(payload.contact?.campos_legiveis).toEqual([
      { rotulo: "Endereço", valor: "Rua das Flores, 100 — Vitória/ES" },
      { rotulo: "Convênio", valor: "Unimed Vitória" },
      { rotulo: "Observacao", valor: "informou o CPF [CPF omitido] na recepção" },
    ]);
    expect(payload.contact?.custom_fields).toMatchObject({ endereco: "Rua das Flores, 100 — Vitória/ES", convenio: "unimed" });
    expect(JSON.stringify(payload)).not.toContain("ROTULO-DE-OUTRA-ORG");
  });

  it("⭐ o CPF guardado em campo personalizado não sai em claro em NENHUM lugar do arquivo de dados", async () => {
    const payload = await collectExportData(pedido);

    const tudo = JSON.stringify(payload);
    expect(tudo).not.toContain(CPF);
    expect(tudo).not.toContain("529.982");
    expect(payload.contact?.custom_fields).not.toHaveProperty("cpf");
    expect(payload.contact?.cpf_em_campo_personalizado).toBe(true);
    // A coluna cifrada não foi inventada: o relatório distingue os dois.
    expect(payload.contact?.cpf_present).toBe(false);
  });

  it("contato sem campo personalizado: bloco vazio, sem acusar CPF", async () => {
    rows.contacts = [{ id: TITULAR, organization_id: ORG, name: "Joana Teste", created_at: "2026-09-01T00:00:00Z" }];

    const payload = await collectExportData(pedido);

    expect(payload.contact?.custom_fields).toEqual({});
    expect(payload.contact?.campos_legiveis).toEqual([]);
    expect(payload.contact?.cpf_em_campo_personalizado).toBe(false);
  });

  const proposta = (id: string, over: Row = {}): Row => ({
    id,
    organization_id: ORG,
    contact_id: TITULAR,
    campo: "phone_number",
    valor_proposto: "+5527988887777",
    valor_anterior: null,
    conversation_id: "conversa-a",
    trecho: "meu celular é esse",
    status: "pending",
    proposed_at: "2026-09-16T00:00:00Z",
    decided_at: null,
    motivo_recusa: null,
    ...over,
  });

  it("⭐ as propostas de dado que a IA fez para o cadastro saem — só as do titular", async () => {
    rows.contact_field_proposals = [
      proposta("dela"),
      proposta("de-outro-contato", { contact_id: "contato-b", valor_proposto: "+5527900000000" }),
      proposta("de-outra-org", { organization_id: OUTRA_ORG }),
    ];

    const payload = await collectExportData(pedido);

    expect(payload.contact_field_proposals?.map((p) => p.id)).toEqual(["dela"]);
    expect(payload.contact_field_proposals?.[0]).toMatchObject({
      campo: "phone_number",
      valor_proposto: "+5527988887777",
      trecho: "meu celular é esse",
      status: "pending",
    });
  });

  it("o trecho da conversa guardado na proposta também não leva CPF em claro", async () => {
    rows.contact_field_proposals = [proposta("com-cpf", { campo: "name", valor_proposto: "Joana Teste", trecho: `sou a Joana, CPF ${CPF}` })];

    const payload = await collectExportData(pedido);

    expect(payload.contact_field_proposals?.[0]?.trecho).toBe("sou a Joana, CPF [CPF omitido]");
    expect(JSON.stringify(payload.contact_field_proposals)).not.toContain(CPF);
  });

  it("as propostas saem por página, não por teto — 501 saem 501", async () => {
    // A fila é alimentada pela IA enquanto a conversa dura: um `limit` entregaria
    // um relatório de acesso incompleto, em silêncio.
    rows.contact_field_proposals = Array.from({ length: 501 }, (_, i) => proposta(`proposta-${i}`));

    const payload = await collectExportData(pedido);

    expect(payload.contact_field_proposals).toHaveLength(501);
    expect(leituras.filter((l) => l.tabela === "contact_field_proposals").map((l) => l.pagina)).toEqual([
      [0, 499],
      [500, 999],
    ]);
  });
});


describe("LGPD export: CPF fora do arquivo de dados também nos blocos de texto livre (revisão do PR)", () => {
  const CPF = "52998224725";
  const PONTUADO = "529.982.247-25";
  const CONVERSA = "conversa-da-joana";

  beforeEach(() => {
    rows.conversations = [{ id: CONVERSA, organization_id: ORG, contact_id: TITULAR, status: "open", channel: "whatsapp" }];
    rows.webhook_lead_captures = [
      {
        id: "captacao-1",
        organization_id: ORG,
        contact_id: TITULAR,
        source_name: "Landing page",
        outcome: "created",
        captured_name: "Joana Teste",
        fields: { nome: "Joana Teste", telefone: "27999990000", cpf: PONTUADO, observacao: `meu cpf é ${CPF}` },
        received_at: "2026-09-01T00:00:00Z",
      },
    ];
    rows.agent_cases = [
      {
        id: "caso-dela", organization_id: ORG, conversation_id: CONVERSA, status: "awaiting_human",
        title: `Convênio da Joana (CPF ${PONTUADO})`, summary: `Paciente informou CPF ${PONTUADO} para o convênio`,
        blocker: `Conferir o CPF ${CPF}`, source: "agent",
      },
    ];
    rows.agent_case_events = [
      { id: "evento-dela", organization_id: ORG, case_id: "caso-dela", kind: "human_replied", actor_kind: "human", body: `CPF dela: ${PONTUADO}`, metadata: { trecho: `cpf ${CPF}` } },
    ];
    rows.demandas = [
      { id: "demanda-dela", organization_id: ORG, contact_id: TITULAR, origem: "handoff", assunto: `Guia do convênio, CPF ${PONTUADO}`, estado: "aberta", dono_kind: "humano", proximo_passo: `Mandar o CPF ${CPF} à operadora` },
    ];
    rows.agent_inbox_items = [
      { id: "aviso-dela", organization_id: ORG, kind: "handoff", title: `Assumir (CPF ${PONTUADO})`, body: `Resumo: CPF ${CPF}`, status: "open", ref_kind: "conversation", ref_id: CONVERSA },
    ];
    rows.contact_channel_identities = [
      { id: "ident-1", organization_id: ORG, contact_id: TITULAR, channel: "instagram", external_id: "IGSID-DA-JOANA" },
    ];
    rows.instagram_comments = [
      { id: "comentario-1", organization_id: ORG, contact_id: null, autor_igsid: "IGSID-DA-JOANA", media_id: "post-1", texto: `meu cpf ${PONTUADO}`, sugestao_de_resposta: `Oi, recebemos o CPF ${PONTUADO}`, motivo_do_toque: `informou CPF ${CPF}`, comentado_em: "2026-09-10T00:00:00Z", situacao: "novo" },
    ];
  });

  it("⭐ nenhum bloco do arquivo de dados leva o CPF — captação, caso, linha do tempo, demanda, aviso, comentário", async () => {
    const payload = await collectExportData(pedido);

    const tudo = JSON.stringify(payload);
    expect(tudo).not.toContain(CPF);
    expect(tudo).not.toContain(PONTUADO);
    expect(tudo).not.toContain("529.982");
    // Controle: os blocos vieram, com o texto em volta do CPF.
    expect(payload.webhook_captures[0]?.fields).toMatchObject({ nome: "Joana Teste", telefone: "27999990000" });
    expect(payload.webhook_captures[0]?.fields).not.toHaveProperty("cpf");
    expect(payload.cases?.[0]?.summary).toBe("Paciente informou CPF [CPF omitido] para o convênio");
    expect(payload.case_events?.[0]?.body).toBe("CPF dela: [CPF omitido]");
    expect(payload.demandas?.[0]?.proximo_passo).toBe("Mandar o CPF [CPF omitido] à operadora");
    expect(payload.avisos_da_central?.[0]?.title).toBe("Assumir (CPF [CPF omitido])");
    expect(payload.instagram_comments?.[0]?.texto).toBe("meu cpf [CPF omitido]");
  });
});

describe("LGPD export: a descrição e os campos do NEGÓCIO, e o texto das atividades (revisão do PR)", () => {
  const CPF = "52998224725";

  beforeEach(() => {
    rows.crm_pipelines = [
      {
        id: "funil-implante",
        organization_id: ORG,
        is_default: false,
        is_archived: false,
        settings: { fields: [{ key: "convenio", label: "Convênio", type: "text" }] },
      },
    ];
    rows.crm_leads = [
      {
        id: "negocio-dela", organization_id: ORG, contact_id: TITULAR, pipeline_id: "funil-implante", stage_id: "etapa-1",
        title: "Implante da Joana", status: "open", value_cents: 500000, currency: "BRL", created_at: "2026-09-02T00:00:00Z",
        description: `Quer implante; CPF ${CPF} para o orçamento`,
        custom_fields: { convenio: "Unimed 0012345", procedimento: "implante", cpf: CPF },
      },
      {
        id: "negocio-do-pedro", organization_id: ORG, contact_id: "contato-b", pipeline_id: "funil-implante", stage_id: "etapa-1",
        title: "Pedro", status: "open", description: "do Pedro", custom_fields: { convenio: "Pedro" },
      },
    ];
    rows.crm_lead_activities = [
      {
        id: "atividade-dela", organization_id: ORG, contact_id: TITULAR, lead_id: "negocio-dela", type: "note", source_module: "crm",
        performed_at: "2026-09-03T00:00:00Z", payload: { texto: "Ligou pedindo retorno" }, metadata: { quem: "recepção" },
        reason: `Pediu retorno sobre o implante; CPF ${CPF}`,
      },
    ];
  });

  it("⭐ o que a anonimização apaga do negócio sai no relatório: descrição e campos, com o nome do campo", async () => {
    const payload = await collectExportData(pedido);

    expect(payload.leads.map((l) => l.id)).toEqual(["negocio-dela"]);
    expect(payload.leads[0]).toMatchObject({
      description: "Quer implante; CPF [CPF omitido] para o orçamento",
      custom_fields: { convenio: "Unimed 0012345", procedimento: "implante" },
      campos_legiveis: [
        { rotulo: "Convênio", valor: "Unimed 0012345" },
        { rotulo: "Procedimento", valor: "implante" },
      ],
    });
  });

  it("⭐ a atividade leva o texto que a anonimização apaga (conteúdo, metadados, motivo)", async () => {
    const payload = await collectExportData(pedido);

    expect(payload.activities[0]).toMatchObject({
      payload: { texto: "Ligou pedindo retorno" },
      metadata: { quem: "recepção" },
      reason: "Pediu retorno sobre o implante; CPF [CPF omitido]",
    });
    expect(JSON.stringify(payload)).not.toContain(CPF);
    // O CPF de campo de negócio também acende a linha do PDF.
    expect(payload.contact?.cpf_em_campo_personalizado).toBe(true);
  });
});

describe("LGPD export: o cadastro antigo UNIDO ao do titular (revisão do PR)", () => {
  beforeEach(() => {
    rows.contacts = [
      { id: TITULAR, organization_id: ORG, name: "Joana Teste", created_at: "2026-09-01T00:00:00Z" },
      {
        id: "lapide-da-joana", organization_id: ORG, is_merged_into: TITULAR, merged_at: "2026-09-05T00:00:00Z",
        name: "Joana T.", display_name: "joana.insta", email: "joana@antigo.test", phone_number: "+5527988880000",
        birthdate: "1990-01-01", created_at: "2026-08-01T00:00:00Z",
      },
      { id: "lapide-do-pedro", organization_id: ORG, is_merged_into: "contato-b", name: "Pedro", created_at: "2026-08-01T00:00:00Z" },
    ];
    rows.conversations = [
      // A conversa que colidiu na fusão e FICOU na lápide.
      { id: "conversa-na-lapide", organization_id: ORG, contact_id: "lapide-da-joana", status: "closed", channel: "instagram" },
    ];
    rows.agent_cases = [
      { id: "caso-na-lapide", organization_id: ORG, conversation_id: "conversa-na-lapide", status: "resolved", title: "Caso antigo", summary: "s", blocker: "b", source: "agent" },
    ];
  });

  it("⭐ o cadastro unido sai no relatório — e a conversa que ficou nele também", async () => {
    const payload = await collectExportData(pedido);

    expect(payload.contatos_unidos).toEqual([
      expect.objectContaining({
        id: "lapide-da-joana", name: "Joana T.", email: "joana@antigo.test", phone_number: "+5527988880000",
      }),
    ]);
    expect(payload.conversations.map((c) => c.id)).toEqual(["conversa-na-lapide"]);
    expect(payload.cases?.map((c) => c.id)).toEqual(["caso-na-lapide"]);
    expect(JSON.stringify(payload)).not.toContain("Pedro");
  });
});
