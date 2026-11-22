import { describe, expect, it, vi } from "vitest";
import { EntradaDoResumo, enviarResumo, telefoneDoDestinatario, type Dependencias } from "./enviar-resumo";

const PDF = Buffer.from("%PDF-1.4\n%fim\n").toString("base64");
const base = { semana: "2026-W47", legenda: "Resumo da semana", nome_arquivo: "resumo-17-a-23-11.pdf", pdf_base64: PDF,
  destinatarios: [{ nome: "André", telefone: "27 99999-0000" }] };

function deps(over: Partial<Dependencias> = {}): Dependencias {
  const linhas: { semana: string; telefone: string; status: string }[] = [];
  return {
    reservar: vi.fn(async (semana: string, telefone: string) => {
      const l = linhas.find((x) => x.semana === semana && x.telefone === telefone);
      if (!l) { linhas.push({ semana, telefone, status: "enviando" }); return "nova" as const; }
      if (l.status === "falhou") { l.status = "enviando"; return "nova" as const; }
      return "ja" as const;
    }),
    concluir: vi.fn(async (semana: string, telefone: string, status: "enviado" | "falhou") => {
      linhas.find((x) => x.semana === semana && x.telefone === telefone)!.status = status;
    }),
    acharOuCriarContato: vi.fn(async () => "c1"),
    sessao: vi.fn(async () => "s1"),
    conversa: vi.fn(async () => "v1"),
    subirPdf: vi.fn(async () => "org/v1/resumo-2026-W47.pdf"),
    espacar: vi.fn(async () => {}),
    enviar: vi.fn(async () => ({ id: "m1", status: "sent" })),
    auditar: vi.fn(async () => {}),
    ...over,
  };
}

describe("EntradaDoResumo", () => {
  it("recusa PDF falso, mais de 5 destinatários e semana fora do formato", () => {
    expect(EntradaDoResumo.safeParse({ ...base, pdf_base64: Buffer.from("<html>").toString("base64") }).success).toBe(false);
    expect(EntradaDoResumo.safeParse({ ...base, destinatarios: Array(6).fill(base.destinatarios[0]) }).success).toBe(false);
    expect(EntradaDoResumo.safeParse({ ...base, semana: "semana-47" }).success).toBe(false);
    expect(EntradaDoResumo.safeParse({ ...base, nome_arquivo: "../x.pdf" }).success).toBe(false);
    expect(EntradaDoResumo.safeParse(base).success).toBe(true);
  });
});

describe("telefoneDoDestinatario", () => {
  it("com e sem 55, com e sem máscara, dá o mesmo número canônico", () => {
    const a = telefoneDoDestinatario("27 99999-0000");
    const b = telefoneDoDestinatario("+55 (27) 99999-0000");
    expect(a).toEqual(b);
    expect(a.digitos).toBe("5527999990000");
    expect(a.variantes).toContain("+5527999990000");
  });
});

describe("enviarResumo", () => {
  it("envia uma vez e o segundo pedido da mesma semana conta como já enviado", async () => {
    const d = deps();
    const e = EntradaDoResumo.parse(base);
    expect(await enviarResumo({} as never, "org", e, "r1", d)).toEqual({ enviados: 1, ja_enviados: 0, falhas: [] });
    expect(await enviarResumo({} as never, "org", e, "r2", d)).toEqual({ enviados: 0, ja_enviados: 1, falhas: [] });
    expect(d.enviar).toHaveBeenCalledTimes(1);
    expect(d.auditar).toHaveBeenCalledTimes(2);
  });
  it("mensagem devolvida como failed ou queued é falha e libera nova tentativa", async () => {
    const d = deps({ enviar: vi.fn(async () => ({ id: "m1", status: "failed" })) });
    const e = EntradaDoResumo.parse(base);
    const r = await enviarResumo({} as never, "org", e, "r1", d);
    expect(r.falhas).toEqual([{ final: "0000", codigo: "nao_enviado" }]);
    (d.enviar as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "m2", status: "sent" });
    expect((await enviarResumo({} as never, "org", e, "r2", d)).enviados).toBe(1);
  });
  it("sem número conectado: falha clara para todos, sem tentar enviar", async () => {
    const d = deps({ sessao: vi.fn(async () => null) });
    const r = await enviarResumo({} as never, "org", EntradaDoResumo.parse(base), "r1", d);
    expect(r.falhas[0]?.codigo).toBe("sem_whatsapp_conectado");
    expect(d.enviar).not.toHaveBeenCalled();
  });
  it("o telefone é canonizado antes de reservar (com e sem 55 é o mesmo número)", async () => {
    const d = deps();
    await enviarResumo({} as never, "org", EntradaDoResumo.parse(base), "r1", d);
    await enviarResumo({} as never, "org", EntradaDoResumo.parse({ ...base, destinatarios: [{ nome: "André", telefone: "+55 27 99999-0000" }] }), "r2", d);
    expect(d.enviar).toHaveBeenCalledTimes(1);
  });
  it("exceção no meio vira falha registrada, sem derrubar os outros destinatários", async () => {
    const d = deps({ conversa: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("v2") });
    const e = EntradaDoResumo.parse({ ...base, destinatarios: [{ nome: "A", telefone: "27999990000" }, { nome: "B", telefone: "27988887777" }] });
    const r = await enviarResumo({} as never, "org", e, "r1", d);
    expect(r).toEqual({ enviados: 1, ja_enviados: 0, falhas: [{ final: "0000", codigo: "erro_no_envio" }] });
  });
});
