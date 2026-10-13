import { describe, expect, it } from "vitest";

import {
  ehClienteParaOFunil,
  temCadastroDePaciente,
  type FatosDoContato,
  type RegrasDeCliente,
} from "@/lib/contacts/cliente-para-o-funil";

/**
 * A decisão "é cliente, para fins de funil?" em todas as combinações.
 *
 * As colunas da tabela são as três configurações que uma organização pode ter
 * hoje mais a quarta (as duas ligadas); as linhas são os contatos que existem
 * na clínica: com horário, só com cadastro, com os dois, com nenhum,
 * anonimizado e mesclado.
 */
const DESLIGADO: RegrasDeCliente = { pelaAgenda: false, peloCadastro: false };
const SO_AGENDA: RegrasDeCliente = { pelaAgenda: true, peloCadastro: false };
const SO_CADASTRO: RegrasDeCliente = { pelaAgenda: false, peloCadastro: true };
const AS_DUAS: RegrasDeCliente = { pelaAgenda: true, peloCadastro: true };

const DATA = "2026-01-10T12:00:00Z";

const casos: Array<[string, FatosDoContato, [boolean, boolean, boolean, boolean]]> = [
  //                                                        desl.  agenda cadastro duas
  ["sem horário e sem cadastro", {}, [false, false, false, false]],
  ["com horário, sem cadastro", { first_service_at: DATA }, [false, true, false, true]],
  ["só CPF", { temCpf: true }, [false, false, true, true]],
  ["só vínculo com o prontuário", { temProntuario: true }, [false, false, true, true]],
  ["CPF e vínculo", { temCpf: true, temProntuario: true }, [false, false, true, true]],
  ["horário e CPF", { first_service_at: DATA, temCpf: true }, [false, true, true, true]],
  [
    "anonimizado com CPF e vínculo",
    { temCpf: true, temProntuario: true, is_anonymized: true },
    [false, false, false, false],
  ],
  [
    "mesclado com CPF",
    { temCpf: true, is_merged_into: "00000000-0000-4000-8000-000000000001" },
    [false, false, false, false],
  ],
];

describe("ehClienteParaOFunil", () => {
  it.each(casos)("%s", (_nome, contato, [desligado, agenda, cadastro, duas]) => {
    expect(ehClienteParaOFunil(contato, DESLIGADO)).toBe(desligado);
    expect(ehClienteParaOFunil(contato, SO_AGENDA)).toBe(agenda);
    expect(ehClienteParaOFunil(contato, SO_CADASTRO)).toBe(cadastro);
    expect(ehClienteParaOFunil(contato, AS_DUAS)).toBe(duas);
  });

  it("contato que não foi lido não é cliente em nenhuma configuração", () => {
    expect(ehClienteParaOFunil(null, AS_DUAS)).toBe(false);
    expect(ehClienteParaOFunil(undefined, AS_DUAS)).toBe(false);
  });

  it("a regra da agenda continua lendo SÓ a data: anonimizado com data segue como antes", () => {
    // `first_service_at` é preservada na anonimização (migration 0262) e a regra
    // do upstream nunca olhou `is_anonymized`. Com a opção nova desligada nada
    // pode mudar, nem neste canto.
    const anonimizadoComData = { first_service_at: DATA, is_anonymized: true };
    expect(ehClienteParaOFunil(anonimizadoComData, SO_AGENDA)).toBe(true);
    expect(ehClienteParaOFunil(anonimizadoComData, SO_CADASTRO)).toBe(false);
  });

  it("a etiqueta não entra na conta: quem só tem a tag não é cliente", () => {
    // O tipo nem aceita `tags`; o teste existe para a intenção ficar escrita.
    const soEtiqueta = { tags: ["cliente"] } as FatosDoContato;
    expect(ehClienteParaOFunil(soEtiqueta, AS_DUAS)).toBe(false);
  });
});

describe("temCadastroDePaciente", () => {
  it("vínculo ou CPF bastam; nenhum dos dois, não", () => {
    expect(temCadastroDePaciente({ temProntuario: true })).toBe(true);
    expect(temCadastroDePaciente({ temCpf: true })).toBe(true);
    expect(temCadastroDePaciente({ first_service_at: DATA })).toBe(false);
  });
});
