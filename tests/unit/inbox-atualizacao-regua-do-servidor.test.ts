import { describe, expect, it } from "vitest";
import {
  julgarAtualizacao,
  mesclarConversa,
  pedeOServidor,
} from "@/lib/inbox/atualizacao-da-lista";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * O JULGAMENTO NO CLIENTE NÃO PODE TIRAR DA LISTA O QUE O SERVIDOR MANTÉM (#2366).
 *
 * `julgarAtualizacao` só pode dizer "sai" quando a rota (`_handler.ts`) também
 * tiraria a conversa. Onde a régua do cliente difere da do servidor, a linha some
 * da tela e volta no próximo refetch — o mesmo estado falso que o conserto quis
 * evitar, na direção contrária. E `pedeOServidor` é a outra metade: o que o
 * evento de `conversations` não sabe responder vai para a recarga, nunca para a
 * mescla.
 *
 * Portado do projeto original (DeskcommCRM, PR #3806 de @webtecnica), adaptado.
 */

/** Uma linha como a rota da lista a devolve: colunas, embeds e a etapa resolvida. */
function linha(extras: Record<string, unknown> = {}): ConversationWithContact {
  return {
    id: "c1",
    status: "open",
    channel: "whatsapp",
    contact_id: "contato-1",
    channel_session_id: "sessao-1",
    assigned_to_user_id: "u-outra",
    assigned_to_user_name: "Outra",
    assignee_kind: "user",
    bot_silenced_until: null,
    contato_oculto: false,
    unread_count_for_assignee: 0,
    last_message_at: "2026-11-03T12:00:00.123456+00:00",
    tags: [],
    contacts: {
      id: "contato-1",
      display_name: "Ana",
      name: "Ana",
      phone_number: "+5527999990000",
      tags: ["retorno"],
      is_blocked: false,
      is_anonymized: false,
      force_human: false,
    },
    channel_sessions: { phone_number: "+5527999991111", display_name: "Recepção", provider: null },
    etapa_atual: "Avaliação",
    ...extras,
  } as unknown as ConversationWithContact;
}

const base = linha();

describe("julgarAtualizacao segue a régua da rota", () => {
  it("exclude_finished esconde só closed/archived (CONVERSATION_TERMINAL_STATUSES), não resolved", () => {
    expect(julgarAtualizacao(base, { id: "c1", status: "resolved" }, { exclude_finished: true })).not.toBe("sai");
    expect(julgarAtualizacao(base, { id: "c1", status: "closed" }, { exclude_finished: true })).toBe("sai");
  });

  it("Minhas: dono trocado fica com o servidor; o resto se decide aqui", () => {
    // Na rota do fork, Minhas é só `assigned_to_user_id = eu` (sem participação),
    // então o dono em cache nesta aba é sempre quem olha e "sai" seria decidível.
    // `indecidivel` fica de propósito: é o lado conservador (o servidor confirma
    // a transferência) e mantém a paridade com o original.
    expect(
      julgarAtualizacao(base, { id: "c1", assigned_to_user_id: "u-terceira" }, { assigned_to: "me" }),
    ).toBe("indecidivel");
    expect(julgarAtualizacao(base, { id: "c1", status: "pending" }, { assigned_to: "me" })).toBe("fica");
  });

  it("aba Ocultos: quem decide é o servidor, mesmo num evento só de etiqueta", () => {
    expect(
      julgarAtualizacao(linha({ contato_oculto: true }), { id: "c1", tags: ["vip"] }, { ocultos: true }),
    ).toBe("indecidivel");
  });

  it("contato oculto do Inbox (0372) sai das abas normais na hora", () => {
    expect(julgarAtualizacao(base, { id: "c1", contato_oculto: true }, {})).toBe("sai");
    expect(julgarAtualizacao(base, { id: "c1", contato_oculto: true }, { status: "open" })).toBe("sai");
  });

  it("o filtro de canal (Só Instagram / Só WhatsApp) é o mesmo da rota", () => {
    expect(julgarAtualizacao(base, { id: "c1", channel: "instagram" }, { canal: "whatsapp" })).toBe("sai");
    expect(julgarAtualizacao(base, { id: "c1", tags: ["vip"] }, { canal: "whatsapp" })).toBe("fica");
  });
});

describe("mesclarConversa", () => {
  it("o nome do atendente vem do evento (coluna 0202); embeds e etapa ficam os da rota", () => {
    const mesclada = mesclarConversa(base, {
      id: "c1",
      assigned_to_user_id: "u-nova",
      assigned_to_user_name: "Nova",
      // Nunca vêm num evento de `conversations`; se vierem, não apagam a linha.
      contacts: null,
      channel_sessions: null,
      etapa_atual: undefined,
    });
    expect(mesclada.assigned_to_user_id).toBe("u-nova");
    expect(mesclada.assigned_to_user_name).toBe("Nova");
    expect(mesclada.contacts).toEqual(base.contacts);
    expect(mesclada.channel_sessions).toEqual(base.channel_sessions);
    expect(mesclada.etapa_atual).toBe("Avaliação");
  });
});

describe("pedeOServidor: o que o evento não responde vai para a recarga", () => {
  it.each([
    // A ordem da lista é da rota.
    ["last_message_at", "2026-11-03T12:05:00+00:00"],
    ["awaiting_since", "2026-11-03T12:05:00+00:00"],
    ["last_inbound_at", "2026-11-03T12:05:00+00:00"],
    ["last_outbound_at", "2026-11-03T12:05:00+00:00"],
    // Os embeds são resolvidos na rota ("Juntar fichas" troca o contato).
    ["contact_id", "contato-2"],
    ["channel_session_id", "sessao-2"],
  ])("mudou %s", (campo, valor) => {
    expect(pedeOServidor(base, { id: "c1", [campo]: valor })).toBe(true);
  });

  it("silêncio trocado ('infinity' → null): a devolução mexe no contato, que o evento não traz", () => {
    expect(pedeOServidor(linha({ bot_silenced_until: "infinity" }), { id: "c1", bot_silenced_until: null })).toBe(
      true,
    );
  });

  it("linha de contato com a equipe ou descadastrado vai sempre ao servidor", () => {
    const comEquipe = linha({ contacts: { ...base.contacts, force_human: true } });
    const descadastrado = linha({ contacts: { ...base.contacts, is_blocked: true } });
    expect(pedeOServidor(comEquipe, { id: "c1", tags: ["vip"] })).toBe(true);
    expect(pedeOServidor(descadastrado, { id: "c1", tags: ["vip"] })).toBe(true);
  });

  it("etiqueta, não lidos e status sozinhos — e o mesmo instante repetido — não pedem", () => {
    expect(pedeOServidor(base, { id: "c1", tags: ["vip"] })).toBe(false);
    expect(pedeOServidor(base, { id: "c1", unread_count_for_assignee: 0 })).toBe(false);
    expect(pedeOServidor(base, { id: "c1", status: "closed" })).toBe(false);
    expect(pedeOServidor(base, { id: "c1", last_message_at: "2026-11-03T12:00:00.123456+00:00" })).toBe(false);
  });
});

describe("o relógio do navegador não decide a Fila perto do fim de uma pausa", () => {
  const agora = new Date("2026-11-03T15:00:00.000Z");
  const semDono = (silencio: string | null) =>
    linha({
      assigned_to_user_id: null,
      assigned_to_user_name: null,
      assignee_kind: null,
      bot_silenced_until: silencio,
    });
  const lida = { id: "c1", unread_count_for_assignee: 0 };
  const fila = { comando: ["aguardando"] as const };
  const minutos = (n: number) => new Date(agora.getTime() + n * 60_000).toISOString();

  it("pausa que acaba daqui a 3 min: o servidor decide", () => {
    expect(julgarAtualizacao(semDono(minutos(3)), lida, fila, agora)).toBe("indecidivel");
  });

  it("pausa que acabou há 3 min (relógio do PC pode estar adiantado): o servidor decide", () => {
    expect(julgarAtualizacao(semDono(minutos(-3)), lida, fila, agora)).toBe("indecidivel");
  });

  it("pausa que acabou há 2 h: o automático voltou, a conversa sai da Fila", () => {
    expect(julgarAtualizacao(semDono(minutos(-120)), lida, fila, agora)).toBe("sai");
  });

  it("silêncio durável ('infinity'): continua esperando gente", () => {
    expect(julgarAtualizacao(semDono("infinity"), lida, fila, agora)).toBe("fica");
  });
});
