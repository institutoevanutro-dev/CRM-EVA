// @vitest-environment node
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderLgpdPdf } from "@/lib/lgpd/pdf-renderer";
import type { ExportPayload } from "@/lib/lgpd/export-collector";

/**
 * O PDF é o que o titular RECEBE (o worker manda o link dele; o `data.json`
 * fica guardado). Bloco que só existe no JSON não chega a quem pediu os dados —
 * por isso o que a migration 0317 passou a apagar tem de aparecer aqui.
 */

function payload(): ExportPayload {
  return {
    request_id: "3f2a9c10-0000-4000-8000-000000000001",
    organization_id: "8c1d4e20-0000-4000-8000-000000000002",
    organization_legal_name: "Bem Viver Servicos Medicos LTDA",
    organization_display_name: "MARCA_DO_REVENDEDOR_NAO_USAR",
    dpo_email: "encarregado@bemviver.test",
    generated_at: "2030-01-02T13:05:00Z",
    no_local_footprint: false,
    contact: null,
    consents: [],
    conversations: [],
    messages_count_total: 0,
    messages_recent: [],
    leads: [],
    orders: [],
    activities: [],
    appointments: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    meeting_deliveries: [],
    appointment_notices: [],
    voice_calls: [],
    channel_identities: [],
    campaign_recipients: [],
    campaign_suppressions: [],
  };
}

async function texto(data: ExportPayload): Promise<string> {
  const bytes = await renderLgpdPdf(data);
  const fonts =
    join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts") + sep;
  const task = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: fonts });
  const document = await task.promise;
  try {
    const paginas: string[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const conteudo = await (await document.getPage(n)).getTextContent();
      paginas.push(conteudo.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return paginas.join("\n").replace(/\s+/g, " ");
  } finally {
    await task.destroy();
  }
}

it("o PDF mostra o caso que a IA abriu, o que a equipe respondeu, a demanda e os avisos", async () => {
  const data = payload();
  data.cases = [
    {
      id: "caso-1",
      conversation_id: "conversa-1",
      status: "awaiting_human",
      title: "ESTORNO-DA-TITULAR",
      summary: "RESUMO-QUE-A-IA-ESCREVEU",
      blocker: "FALTA-O-COMPROVANTE",
      source: "agent",
      opened_at: "2030-01-02T13:05:00Z",
      closed_at: null,
      created_at: "2030-01-02T13:05:00Z",
    },
  ];
  data.case_events = [
    { id: "ev-1", case_id: "caso-1", kind: "human_replied", actor_kind: "human", human_action: "need_lead_info", body: "RESPOSTA-DA-EQUIPE", metadata: {}, created_at: "2030-01-02T14:00:00Z" },
    { id: "ev-2", case_id: "outro-caso", kind: "human_replied", actor_kind: "human", human_action: null, body: "EVENTO-DE-OUTRO-CASO", metadata: {}, created_at: "2030-01-02T14:00:00Z" },
  ];
  data.demandas = [
    { id: "dem-1", agent_case_id: "caso-1", origem: "handoff", assunto: "ASSUNTO-DA-DEMANDA", estado: "em_atendimento", dono_kind: "humano", proximo_passo: "PROXIMO-PASSO-ANOTADO", desfecho: null, aberta_em: "2030-01-02T13:05:00Z", fechada_em: null },
  ];
  data.avisos_da_central = [
    { id: "av-1", kind: "voice_call_missed", title: "Chamada perdida de +5527999990000", body: "CORPO-DO-AVISO", status: "open", created_at: "2030-01-02T13:05:00Z", resolved_at: null },
  ];

  const pdf = await texto(data);

  for (const trecho of [
    "ESTORNO-DA-TITULAR",
    "RESUMO-QUE-A-IA-ESCREVEU",
    "FALTA-O-COMPROVANTE",
    "RESPOSTA-DA-EQUIPE",
    "ASSUNTO-DA-DEMANDA",
    "PROXIMO-PASSO-ANOTADO",
    "Chamada perdida de +5527999990000",
    "CORPO-DO-AVISO",
  ]) {
    expect(pdf).toContain(trecho);
  }
  // Evento só entra debaixo do caso a que pertence.
  expect(pdf).not.toContain("EVENTO-DE-OUTRO-CASO");
});

it("o PDF mostra o comentário do Instagram e o que ficou guardado sobre ele", async () => {
  const data = payload();
  data.instagram_comments = [
    { id: "c-1", media_id: "post-1", texto: "TEXTO-DO-COMENTARIO", autor_handle: "joana.teste", comentado_em: "2030-01-02T13:05:00Z", situacao: "esperando_voce", sugestao_de_resposta: "RESPOSTA-SUGERIDA", motivo_do_toque: null },
  ];

  const pdf = await texto(data);

  expect(pdf).toContain("Comentários no Instagram");
  expect(pdf).toContain("TEXTO-DO-COMENTARIO");
  expect(pdf).toContain("@joana.teste");
  expect(pdf).toContain("RESPOSTA-SUGERIDA");
});

it("sem nada disso, o PDF não ganha seção vazia — e segue nomeando o controlador, não a marca", async () => {
  const pdf = await texto(payload());

  expect(pdf).not.toContain("Atendimentos encaminhados para a equipe");
  expect(pdf).not.toContain("Pedidos em acompanhamento");
  expect(pdf).not.toContain("Comentários no Instagram");
  expect(pdf).toContain("Bem Viver Servicos Medicos LTDA");
  expect(pdf).not.toContain("MARCA_DO_REVENDEDOR_NAO_USAR");
});

it("o PDF mostra a descrição e os campos do negócio, e os cadastros antigos unidos ao do titular (revisão do PR)", async () => {
  const data = payload();
  data.leads = [
    {
      id: "negocio-1",
      pipeline_id: "funil-1",
      stage_id: "etapa-1",
      title: "Implante",
      status: "open",
      value_cents: null,
      currency: null,
      created_at: "2030-01-02T13:05:00Z",
      description: "DESCRICAO-DO-NEGOCIO",
      custom_fields: { convenio: "UNIMED-0012345" },
      campos_legiveis: [{ rotulo: "Convênio", valor: "UNIMED-0012345" }],
    },
  ];
  data.contatos_unidos = [
    {
      id: "lapide-1",
      name: "NOME-DO-CADASTRO-ANTIGO",
      display_name: null,
      email: "antigo@exemplo.test",
      phone_number: "+5527988880000",
      birthdate: null,
      created_at: "2030-01-01T13:05:00Z",
      merged_at: "2030-01-02T13:05:00Z",
    },
  ];

  const pdf = await texto(data);

  for (const trecho of [
    "DESCRICAO-DO-NEGOCIO",
    "Convênio: UNIMED-0012345",
    "Cadastros antigos unidos a este",
    "NOME-DO-CADASTRO-ANTIGO",
    "antigo@exemplo.test",
    "+5527988880000",
  ]) {
    expect(pdf).toContain(trecho);
  }
});
