/**
 * ANTI-BANIMENTO DA CAMPANHA — as quatro garantias que este fork exige, medidas
 * pelas funções que a rodada (`lib/campanhas/rodada.ts`) chama de verdade:
 *
 *   1. no máximo 1 mensagem a cada 5 s por número, com jitter;
 *   2. só dentro da janela de envio do canal;
 *   3. nunca para quem pediu para parar (`is_blocked`) nem para grupo;
 *   4. com teto diário.
 *
 * O número WhatsApp daqui é WAHA (número "pessoal"): disparo em rajada queima o
 * número, e número queimado volta em semanas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CAMPAIGN_MIN_GAP_MS, PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { decidePacing } from "@/lib/agent-engine/pacing/engine";
import { motivoParaExcluir } from "@/lib/campanhas/elegibilidade";
import { numeroLivreParaCampanha } from "@/lib/campanhas/ritmo";

/** 10h em São Paulo (UTC-3), num dia útil. */
const DEZ_DA_MANHA = new Date("2026-09-18T13:00:00.000Z");
/** 23h em São Paulo — fora da janela padrão 7h-22h. */
const ONZE_DA_NOITE = new Date("2026-09-19T02:00:00.000Z");

const KNOBS = PACING_DEFAULTS;
const SEM_JITTER = () => 0;
const JITTER_MAXIMO = () => 0.999_999;

function decisao(agora: Date, ultimoEnvio: Date | null, sentToday = 0, crmDailyLimit: number | null = 300) {
  return decidePacing({
    now: agora,
    knobs: KNOBS,
    // Número maduro: o degrau de warm-up não interfere no que se mede aqui.
    state: { lastSentAt: ultimoEnvio, sentToday, numberActivatedAt: new Date("2025-01-01T00:00:00Z") },
    crmDailyLimit,
    rng: SEM_JITTER,
  });
}

const atras = (ms: number) => new Date(DEZ_DA_MANHA.getTime() - ms);

describe("1 · no máximo uma mensagem a cada 5 s por número, com jitter", () => {
  it("o piso é 5 s, acima do throttle de 1,2 s do canal", () => {
    expect(CAMPAIGN_MIN_GAP_MS).toBe(5_000);
    expect(CAMPAIGN_MIN_GAP_MS).toBeGreaterThan(KNOBS.throttleMs);
  });

  it("o número falou há 4 s (de qualquer origem): a campanha espera, mesmo com o canal liberando", () => {
    const ultimo = atras(4_000);
    const d = decisao(DEZ_DA_MANHA, ultimo);
    expect(d.allow).toBe(true); // para o AGENTE, 1,2 s já bastavam
    expect(numeroLivreParaCampanha(d, ultimo, DEZ_DA_MANHA, KNOBS, SEM_JITTER)).toBe(false);
  });

  it("5 s exatos sem jitter libera; com o jitter máximo do canal, ainda não", () => {
    const ultimo = atras(5_000);
    const d = decisao(DEZ_DA_MANHA, ultimo);
    expect(numeroLivreParaCampanha(d, ultimo, DEZ_DA_MANHA, KNOBS, SEM_JITTER)).toBe(true);
    expect(numeroLivreParaCampanha(d, ultimo, DEZ_DA_MANHA, KNOBS, JITTER_MAXIMO)).toBe(false);
    const depois = atras(5_000 + KNOBS.jitterMaxMs);
    expect(numeroLivreParaCampanha(d, depois, DEZ_DA_MANHA, KNOBS, JITTER_MAXIMO)).toBe(true);
  });

  it("canal que ainda pede espera (`waitMs > 0`) não libera a campanha — ela não dorme, espera a rodada", () => {
    expect(numeroLivreParaCampanha({ allow: true, waitMs: 300 }, null, DEZ_DA_MANHA, KNOBS)).toBe(false);
  });

  it("canal com throttle maior que 5 s vale o do canal: a campanha só sabe ir mais devagar", () => {
    const lento = { ...KNOBS, throttleMs: 60_000 };
    const ultimo = atras(30_000);
    expect(numeroLivreParaCampanha({ allow: true, waitMs: 0 }, ultimo, DEZ_DA_MANHA, lento, SEM_JITTER)).toBe(false);
  });

  it("a campanha pega o MESMO lock por número da cadeia de envio do agente", () => {
    const ler = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    const LOCK = /pg_advisory_xact_lock\(hashtext\(\$1\)\)/;
    expect(ler("lib/agent-engine/guardrails/before-send.ts")).toMatch(LOCK);
    const rodada = ler("lib/campanhas/rodada.ts");
    expect(rodada).toMatch(LOCK);
    // e registra o envio no `pacing_ledger` pela conexão que segura o lock
    expect(rodada).toMatch(/recordSend\(conexao,/);
  });
});

describe("2 · só dentro da janela de envio do canal", () => {
  it("às 23h (janela 7h-22h) o número não está livre, mesmo parado há horas", () => {
    const ultimo = new Date(ONZE_DA_NOITE.getTime() - 3 * 3_600_000);
    const d = decisao(ONZE_DA_NOITE, ultimo);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("outside_window");
    expect(numeroLivreParaCampanha(d, ultimo, ONZE_DA_NOITE, KNOBS)).toBe(false);
  });
});

describe("3 · nunca para quem pediu para parar, nem para grupo", () => {
  const base = {
    contactId: "c1",
    telefone: "+5511999990000",
    bloqueado: false,
    anonimizado: false,
    recusouMarketing: false,
  };

  it("contato com opt-out (`is_blocked`) sai como opt_out — e a rodada revalida no envio", () => {
    expect(motivoParaExcluir({ ...base, bloqueado: true })).toBe("opt_out");
  });

  it("endereço de grupo (`@g.us`) não é telefone de envio: fica de fora", () => {
    expect(motivoParaExcluir({ ...base, telefone: "120363025555555555@g.us" })).toBe("telefone_invalido");
  });

  it("controle: o mesmo contato, sem veto, é elegível", () => {
    expect(motivoParaExcluir(base)).toBeNull();
  });
});

describe("4 · com teto diário", () => {
  it("número que já mandou o teto do dia não está livre para a campanha", () => {
    const ultimo = atras(10 * 60_000);
    const d = decisao(DEZ_DA_MANHA, ultimo, 300, 300);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("daily_cap");
    expect(numeroLivreParaCampanha(d, ultimo, DEZ_DA_MANHA, KNOBS)).toBe(false);
  });

  it("o teto do número existe sempre: `channel_sessions.daily_message_limit` é NOT NULL com default", () => {
    const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
    expect(baseline).toMatch(/"daily_message_limit" integer DEFAULT \d+ NOT NULL/);
  });
});
