import { describe, expect, it } from "vitest";

import {
  avisosDaJuncao,
  motivoQueImpedeAJuncao,
  quemFicaPorPadrao,
  type FichaParaComparar,
} from "@/lib/contacts/juncao";

/**
 * As regras da TELA de junção (porte do #3640): quem fica por padrão, o que
 * impede juntar e os avisos que a confirmação mostra. Cada aviso descreve o que
 * `fn_mesclar_contatos` e a rota de fusão fazem de verdade com a ficha
 * absorvida. Nomes fictícios; cada caso diz a sabotagem que o deixa vermelho.
 */
const t = (texto: string) => texto;

function ficha(id: string, campos: Partial<FichaParaComparar> = {}): FichaParaComparar {
  return {
    id,
    name: `Ficha ${id}`,
    display_name: null,
    phone_number: null,
    email: null,
    birthdate: null,
    cpf_available: false,
    endereco: null,
    prontuario_linked: false,
    is_blocked: false,
    force_human: false,
    ai_opt_out: false,
    inbox_hidden_at: null,
    source: "whatsapp",
    created_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: null,
    conversas: 0,
    negocios: 0,
    ...campos,
  };
}

describe("quemFicaPorPadrao", () => {
  it("a ficha ligada ao prontuário vence o padrão", () => {
    // Sabotagem: devolver sempre o padrão sugeriria absorver a ficha ligada.
    const a = ficha("a");
    const b = ficha("b", { prontuario_linked: true, cpf_available: false });
    expect(quemFicaPorPadrao(a, b, "a")).toBe("b");
    expect(quemFicaPorPadrao(b, a, "a")).toBe("b");
  });

  it("sem vínculo, vence a que tem CPF (o CPF da absorvida não passa)", () => {
    expect(quemFicaPorPadrao(ficha("a"), ficha("b", { cpf_available: true }), "a")).toBe("b");
  });

  it("sem diferença, fica o padrão", () => {
    expect(quemFicaPorPadrao(ficha("a"), ficha("b"), "b")).toBe("b");
    const ambas = { prontuario_linked: true, cpf_available: true };
    expect(quemFicaPorPadrao(ficha("a", ambas), ficha("b", ambas), "a")).toBe("a");
  });
});

describe("motivoQueImpedeAJuncao", () => {
  it("a absorvida ligada ao prontuário: devolve o texto", () => {
    // Sabotagem: devolver null deixaria o botão Juntar levar ao 409.
    expect(motivoQueImpedeAJuncao(ficha("fica"), ficha("sai", { prontuario_linked: true }), t)).toBe(
      "A ficha ligada ao prontuário tem de ser a que fica.",
    );
  });

  it("as duas ligadas: são pacientes diferentes", () => {
    const ligada = { prontuario_linked: true };
    expect(motivoQueImpedeAJuncao(ficha("fica", ligada), ficha("sai", ligada), t)).toBe(
      "As duas fichas estão ligadas a pacientes diferentes do prontuário. Não dá para juntar.",
    );
  });

  it("só quem fica ligada: nada impede", () => {
    expect(motivoQueImpedeAJuncao(ficha("fica", { prontuario_linked: true }), ficha("sai"), t)).toBeNull();
  });
});

describe("avisosDaJuncao", () => {
  it("telefone: só quando as DUAS têm número e as chaves diferem", () => {
    // Sabotagem: avisar quando quem fica não tem número empurraria a escolha para
    // o lado errado (a fusão herda o número nesse caso).
    const comNumero = (id: string, phone_number: string) => ficha(id, { phone_number });
    expect(avisosDaJuncao(comNumero("fica", "+5531988887777"), comNumero("sai", "+5531977776666"), t)).toEqual([
      "O número {tel} não passa para quem fica: a ficha guarda um telefone só. Se chegar mensagem desse número, pode nascer uma ficha nova. Se é o número que a pessoa usa, troque o telefone depois de juntar.".replace(
        "{tel}",
        "+5531977776666",
      ),
    ]);
    expect(avisosDaJuncao(ficha("fica"), comNumero("sai", "+5531977776666"), t)).toEqual([]);
    // O mesmo celular com e sem o nono dígito: a mesma chave, sem aviso.
    expect(avisosDaJuncao(comNumero("fica", "+553198966398"), comNumero("sai", "+5531998966398"), t)).toEqual([]);
  });

  it("bloqueio: só quando a absorvida está bloqueada e quem fica não", () => {
    const aviso =
      "Ficha sai pediu para não receber mensagens. Quem fica também deixa de receber, inclusive lembretes de consulta.";
    expect(avisosDaJuncao(ficha("fica"), ficha("sai", { is_blocked: true }), t)).toEqual([aviso]);
    expect(avisosDaJuncao(ficha("fica", { is_blocked: true }), ficha("sai", { is_blocked: true }), t)).toEqual([]);
  });

  it("IA: 'Sempre atendimento humano' tem precedência sobre a pausa", () => {
    // Sabotagem: avisar as duas coisas (ou só a pausa) descreveria errado o que a rota aplica.
    const sai = ficha("sai", { ai_opt_out: true, force_human: true });
    expect(avisosDaJuncao(ficha("fica"), sai, t)).toEqual([
      "Ficha sai está como Sempre atendimento humano. Quem fica passa a ter a mesma marca.",
    ]);
    expect(avisosDaJuncao(ficha("fica"), ficha("sai", { force_human: true }), t)).toEqual([
      "Ficha sai está com a IA pausada. Quem fica passa a ser atendido só pela equipe até alguém devolver ao automático.",
    ]);
    expect(avisosDaJuncao(ficha("fica", { force_human: true }), ficha("sai", { force_human: true }), t)).toEqual([]);
  });

  it("CPF: nas duas, o texto de CPFs diferentes; só na absorvida, o CPF que não passa", () => {
    const comCpf = { cpf_available: true };
    expect(avisosDaJuncao(ficha("fica", comCpf), ficha("sai", comCpf), t)).toEqual([
      "As duas fichas têm CPF, e são CPFs diferentes: confira se não são duas pessoas. O CPF de Ficha sai não passa para quem fica.",
    ]);
    expect(avisosDaJuncao(ficha("fica"), ficha("sai", comCpf), t)).toEqual([
      "O CPF de Ficha sai não passa para quem fica.",
    ]);
    expect(avisosDaJuncao(ficha("fica", comCpf), ficha("sai"), t)).toEqual([]);
  });

  it("oculto do Inbox: avisa que quem fica continua no Inbox", () => {
    expect(avisosDaJuncao(ficha("fica"), ficha("sai", { inbox_hidden_at: "2026-10-01T00:00:00.000Z" }), t)).toEqual([
      "Ficha sai está oculta do Inbox. Quem fica continua no Inbox, e a IA pode responder.",
    ]);
  });

  it("nome com '$' entra literal: o pushName do WhatsApp não vira padrão do replace", () => {
    // Sabotagem: `.replace("{nome}", nome)` troca "$&" pelo próprio "{nome}",
    // "$'" pelo resto da frase e "$$" por "$".
    const sai = ficha("sai", { name: "Ana $& Lima $' Ca$$ia", force_human: true });
    expect(avisosDaJuncao(ficha("fica"), sai, t)).toEqual([
      "Ana $& Lima $' Ca$$ia está com a IA pausada. Quem fica passa a ser atendido só pela equipe até alguém devolver ao automático.",
    ]);
  });

  it("endereço: igual não avisa; diferente avisa", () => {
    const rua = { endereco: "Rua das Flores, 10" };
    expect(avisosDaJuncao(ficha("fica", rua), ficha("sai", rua), t)).toEqual([]);
    expect(avisosDaJuncao(ficha("fica"), ficha("sai", rua), t)).toEqual([
      "O endereço de Ficha sai não passa para quem fica.",
    ]);
  });
});
