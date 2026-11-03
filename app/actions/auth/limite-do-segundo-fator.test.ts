/**
 * O limite de falhas do segundo fator vale nas DUAS actions que conferem o
 * código — `verifyMfa` (tela de login) e `updatePassword` (troca de senha numa
 * conta com verificação em duas etapas) — e as duas dividem o mesmo balde por
 * usuário e autenticador.
 *
 * O limitador é o de verdade (contador em memória do processo, sem Upstash),
 * e o navegador nunca devolve o cookie `mfa_attempts`: o que barra a quarta
 * tentativa tem de ser o servidor. O que se dubla é só o Supabase (o código é
 * sempre recusado) e o que está em volta.
 *
 * O relógio fica parado no meio do minuto e do dia UTC, e só anda quando um
 * caso manda: com o relógio de verdade, uma virada de minuto no meio do caso
 * levava a contagem para outra chave e a quarta tentativa passava.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const estado = { verificacoes: 0 };
/** O que as actions mandaram para a trilha de auditoria. */
const auditorias: Array<{ action: string; metadata?: Record<string, unknown> }> = [];

/** IP de cada caso; ver o `beforeEach`. */
let ip = "";

vi.mock("next/headers", () => ({
  // Jar vazio a cada requisição: o cliente que não devolve o cookie.
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => ({
    get: (k: string) => (k === "x-forwarded-for" ? ip : null),
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: async (e: { action: string; metadata?: Record<string, unknown> }) => {
    auditorias.push({ action: e.action, metadata: e.metadata });
  },
}));

let usuario = "";
let fator = "";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: usuario } }, error: null }),
      updateUser: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: "aal1", nextLevel: "aal2" },
        }),
        listFactors: async () => ({
          data: { totp: [{ id: fator, status: "verified" }] },
        }),
        challenge: async () => ({ data: { id: "desafio-1" }, error: null }),
        verify: async () => {
          estado.verificacoes += 1;
          return { error: { message: "Invalid TOTP code entered" } };
        },
      },
    },
  }),
}));

const SENHA = { password: "Nova-senha-1", password_confirm: "Nova-senha-1", mfa_code: "000000" };

/**
 * Cinco rodadas de três erros, uma por minuto — o que a tela deixa fazer até o
 * teto do dia. Devolve a resposta do 15º erro.
 */
async function errarODiaInteiro(verifyMfa: (code: string) => Promise<unknown>): Promise<unknown> {
  let ultima: unknown;
  for (let rodada = 0; rodada < 5; rodada++) {
    for (let i = 0; i < 3; i++) ultima = await verifyMfa("000000");
    vi.setSystemTime(Date.now() + 60_000);
  }
  return ultima;
}

describe("o limite de falhas do segundo fator", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:30Z"));
    estado.verificacoes = 0;
    auditorias.length = 0;
    usuario = crypto.randomUUID();
    // IP próprio por caso, pela mesma razão do usuário: com o relógio parado,
    // toda rodada cai na mesma janela, e contra um Redis de pé um IP fixo
    // somaria as falhas das rodadas até o teto de 30 por IP.
    const u = crypto.randomUUID();
    ip = `2001:db8::${u.slice(0, 4)}:${u.slice(4, 8)}:${u.slice(9, 13)}`;
    fator = "fator-1";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifyMfa barra a quarta tentativa sem chegar a conferir o código", async () => {
    const { verifyMfa } = await import("./verifyMfa");
    const respostas = [];
    for (let i = 0; i < 4; i++) respostas.push((await verifyMfa("000000")).error);

    expect(respostas).toEqual(["mfa_invalid", "mfa_invalid", "mfa_invalid", "mfa_locked"]);
    expect(estado.verificacoes).toBe(3);
  });

  it("updatePassword barra a quarta tentativa sem chegar a conferir o código", async () => {
    const { updatePassword } = await import("./updatePassword");
    const respostas = [];
    for (let i = 0; i < 4; i++) respostas.push((await updatePassword(SENHA)).error);

    expect(respostas).toEqual(["mfa_invalid", "mfa_invalid", "mfa_invalid", "mfa_locked"]);
    expect(estado.verificacoes).toBe(3);
  });

  it("as duas telas contam no mesmo balde do usuário", async () => {
    const { verifyMfa } = await import("./verifyMfa");
    const { updatePassword } = await import("./updatePassword");
    for (let i = 0; i < 3; i++) await verifyMfa("000000");

    expect((await updatePassword(SENHA)).error).toBe("mfa_locked");
    expect(estado.verificacoes).toBe(3);
  });

  it("o teto do dia tem recado próprio nas duas telas e vale até a virada do dia UTC (21h de Brasília)", async () => {
    // Antes, o teto do dia respondia `retry_in_seconds: 60`: a tela contava um
    // minuto, destravava, e barrava de novo — até as 21h, com o código certo.
    const { verifyMfa } = await import("./verifyMfa");
    const { updatePassword } = await import("./updatePassword");

    expect(await errarODiaInteiro(verifyMfa)).toEqual({ ok: false, error: "mfa_locked_today" });
    expect(estado.verificacoes).toBe(15);

    expect(await verifyMfa("000000")).toEqual({ ok: false, error: "mfa_locked_today" });
    expect((await updatePassword(SENHA)).error).toBe("mfa_locked_today");
    vi.setSystemTime(new Date("2026-11-03T23:59:59Z"));
    expect((await verifyMfa("000000")).error).toBe("mfa_locked_today");
    expect(estado.verificacoes).toBe(15);

    // 00:00 UTC é 21h em Brasília: é a hora que as telas prometem.
    vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
    expect((await verifyMfa("000000")).error).toBe("mfa_invalid");
    expect(estado.verificacoes).toBe(16);
  });

  it("um autenticador novo volta a ser conferido no mesmo dia", async () => {
    // A saída que as telas apontam: o código de recuperação (ou o
    // `reset-mfa.sh`) apaga o autenticador, e a pessoa cadastra outro.
    const { verifyMfa } = await import("./verifyMfa");
    await errarODiaInteiro(verifyMfa);
    expect((await verifyMfa("000000")).error).toBe("mfa_locked_today");

    fator = "fator-2";
    expect((await verifyMfa("000000")).error).toBe("mfa_invalid");
    expect(estado.verificacoes).toBe(16);
  });

  it("a trilha explica o bloqueio: a falha que o fechou sai trancada, e o erro na troca de senha também entra", async () => {
    const { verifyMfa } = await import("./verifyMfa");
    const { updatePassword } = await import("./updatePassword");
    await updatePassword(SENHA);
    await updatePassword(SENHA);
    await verifyMfa("000000");

    expect(auditorias).toEqual([
      { action: "auth.mfa_failed", metadata: { tela: "reset", locked: false, janela: null } },
      { action: "auth.mfa_failed", metadata: { tela: "reset", locked: false, janela: null } },
      // Sem cookie, `attempts` fica em 1; quem trancou foi o servidor.
      { action: "auth.mfa_failed", metadata: { locked: true, attempts: 1, janela: "minuto" } },
    ]);
  });
});
