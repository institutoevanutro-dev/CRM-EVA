import { describe, expect, it } from "vitest";

import {
  decidirAgendamento,
  ESPERA_DO_NUMERO_FORA_MS,
  RITMO_DO_NUMERO_MS,
  type FatosDoAgendamento,
} from "@/lib/agendamento-mensagem/decisao";

/** Teto de atraso, janela e ritmo do envio ATRASADO; o envio no horário segue como antes. */
const AGORA = new Date("2026-11-16T03:00:00Z");
const min = (n: number) => new Date(AGORA.getTime() - n * 60_000);
const fatos = (f: Partial<FatosDoAgendamento>): FatosDoAgendamento => ({
  agora: AGORA,
  scheduledAt: min(1),
  seDesconectado: "esperar",
  conectado: true,
  janelaAbreEm: null,
  ultimoEnvioDoNumero: null,
  ...f,
});

describe("decidirAgendamento", () => {
  it("no horário sai mesmo fora da janela e logo depois de outro envio do número", () => {
    const abre = new Date("2026-11-16T10:00:00Z");
    expect(decidirAgendamento(fatos({ janelaAbreEm: abre, ultimoEnvioDoNumero: min(0) }))).toEqual({ acao: "enviar" });
  });

  it("mais de 12h de atraso expira, conectado ou não", () => {
    expect(decidirAgendamento(fatos({ scheduledAt: min(12 * 60 + 1) }))).toEqual({ acao: "cancelar", motivo: "expirada" });
    expect(decidirAgendamento(fatos({ scheduledAt: min(13 * 60), conectado: false }))).toEqual({ acao: "cancelar", motivo: "expirada" });
  });

  it("número fora do ar: espera adiando (sai do lote) ou cancela, como escolhido", () => {
    expect(decidirAgendamento(fatos({ conectado: false }))).toEqual({
      acao: "adiar",
      ate: new Date(AGORA.getTime() + ESPERA_DO_NUMERO_FORA_MS),
      razao: "numero_desconectado",
    });
    expect(decidirAgendamento(fatos({ conectado: false, seDesconectado: "cancelar" }))).toEqual({
      acao: "cancelar",
      motivo: "numero_desconectado",
    });
  });

  it("atrasada fora da janela do número espera a janela abrir (sem rajada de madrugada)", () => {
    const abre = new Date("2026-11-16T10:00:00Z");
    expect(decidirAgendamento(fatos({ scheduledAt: min(5 * 60), janelaAbreEm: abre }))).toEqual({
      acao: "adiar",
      ate: abre,
      razao: "fora_da_janela",
    });
  });

  it("atrasada respeita o ritmo do número; passado o intervalo, sai", () => {
    const ultimo = min(0.5);
    expect(decidirAgendamento(fatos({ scheduledAt: min(60), ultimoEnvioDoNumero: ultimo }))).toEqual({
      acao: "adiar",
      ate: new Date(ultimo.getTime() + RITMO_DO_NUMERO_MS),
      razao: "ritmo",
    });
    expect(decidirAgendamento(fatos({ scheduledAt: min(60), ultimoEnvioDoNumero: min(2) }))).toEqual({ acao: "enviar" });
  });
});
