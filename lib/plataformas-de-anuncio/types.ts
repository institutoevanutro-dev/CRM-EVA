/**
 * O vocabulário AGNÓSTICO do eixo de plataformas de anúncio.
 *
 * ─── Por que esta fronteira existe, ao lado de `lib/channels/` ──────────────
 *
 * A doutrina de restrição de canal (`docs/doctrine/restricao-de-canal.md`,
 * invariante 1) diz que nenhuma feature nomeia um provider. `lib/channels/` é a
 * fronteira de quem ENTREGA MENSAGEM. Reportar conversão não tem janela,
 * template, ban nem destinatário, e os dois eixos são independentes: dá para
 * receber lead de anúncio num número servido por qualquer transporte. Então:
 * segunda fronteira, mesma catraca (`scripts/lint-channels.ts`, `ALLOWED`).
 *
 * O nome do endpoint e o formato do payload só aparecem dentro de `meta/` e
 * `google/`. `meta_ads`/`google_ads` podem aparecer fora: são slugs de
 * plataforma (0164), não de transporte.
 */

/** A plataforma que hospeda o anúncio. */
export type PlataformaDeAnuncio = "meta_ads" | "google_ads";

/**
 * Os DOIS eventos que saem desta casa para uma plataforma de anúncio, cada um
 * ligado à parte por plataforma:
 *
 *  - `Schedule` — um paciente AGENDOU (evento padrão da Meta);
 *  - `CompleteRegistration` — o SINAL foi pago, o momento em que a clínica
 *    considera o paciente fechado. Evento padrão da Meta que não exige valor:
 *    `Purchase` exige `value` e `currency`, e valor numa clínica diz o que o
 *    paciente foi tratar.
 *
 * No Google o evento é a ação de conversão que a organização escolheu para cada
 * um. Venda com valor saiu de propósito (migration 0391).
 */
export const EVENTO_AGENDOU = "Schedule";
export const EVENTO_SINAL_PAGO = "CompleteRegistration";
export type NomeDoEvento = typeof EVENTO_AGENDOU | typeof EVENTO_SINAL_PAGO;

/**
 * Um agendamento pronto para sair — no formato da CASA, não no da plataforma.
 *
 * ⚠️ ESTA É A LISTA FECHADA DO QUE PODE SAIR. Não há campo de nome, etapa,
 * procedimento, tipo de consulta, profissional, observação ou valor, e o teste
 * `tests/unit/conversao-de-agendamento.test.ts` reprova o corpo enviado que
 * carregar qualquer coisa além disto.
 */
export interface ConversaoDeAgendamento {
  organizationId: string;
  /** O agendamento (`Schedule`) ou o negócio (`CompleteRegistration`). Só para log e livro-razão; nunca vai no corpo enviado. */
  alvoId: string;
  evento: NomeDoEvento;
  /**
   * Deduplicação na plataforma, e não se reverte: SHA-256 de
   * `organização:alvo:evento`, cortado em 32 hex. A mesma entrada dá o
   * mesmo id, então reenviar nunca conta duas vezes lá do outro lado.
   */
  eventoId: string;
  /** Quando aconteceu (criação do compromisso, ou entrada na etapa do sinal), não quando o worker rodou. */
  ocorridoEm: Date;
  /** E.164 com `+`, ainda em claro: cada transporte normaliza e hasheia do seu jeito. */
  telefone: string | null;
  /** Em claro, só quando o contato tem. Cada transporte normaliza e hasheia. */
  email: string | null;
  /** `ctwa_clid` do anúncio clique-para-WhatsApp, quando o contato tem. */
  cliqueMeta: string | null;
  /** `gclid`, quando o contato tem. Hoje nenhum caminho o captura. */
  cliqueGoogle: string | null;
}

/**
 * O resultado, com a FÍSICA da falha declarada:
 *
 *  - `ok`          → gravado como enviado, nunca reenviado.
 *  - `transitorio` → rede, 5xx, cota. Tenta de novo com espera crescente.
 *  - `permanente`  → token inválido, conta errada, evento velho demais.
 *                    Reagendar não conserta: vira aviso na Central.
 *
 * `codigo` é curto e vai para o livro-razão. A mensagem da plataforma NÃO vai:
 * ela pode repetir dado que foi enviado.
 */
export type ResultadoDeEnvio =
  | { tipo: "ok" }
  | { tipo: "transitorio"; codigo: string }
  | { tipo: "permanente"; codigo: string };

/** Credenciais da Meta, já decifradas. */
export interface CredencialMeta {
  plataforma: "meta_ads";
  datasetId: string;
  accessToken: string;
  /** Preenchido = envio marcado como teste, não conta para otimização. */
  testEventCode: string | null;
}

/** Credenciais do Google Ads, já decifradas. */
export interface CredencialGoogle {
  plataforma: "google_ads";
  /** Só dígitos. */
  customerId: string;
  /** Conta administradora (MCC) por onde se entra, quando houver. Só dígitos. */
  loginCustomerId: string | null;
  conversionActionId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
}

export type CredencialDeConversao = CredencialMeta | CredencialGoogle;

/** O contrato que todo transporte de conversão cumpre. */
export interface TransporteDeConversao<C extends CredencialDeConversao = CredencialDeConversao> {
  plataforma: C["plataforma"];
  enviar(credencial: C, conversao: ConversaoDeAgendamento): Promise<ResultadoDeEnvio>;
}

// ─────────────────────────────────────────────────────────────────────────────
// O EIXO DE LEITURA (0214) — métricas da conta de anúncios, para a tela
// ─────────────────────────────────────────────────────────────────────────────
//
// Vizinho do eixo de conversões acima, e deliberadamente SEM contato com ele.
// Lá o sistema ESCREVE na conta do cliente e o erro custa dinheiro dele (uma
// conversão falsa envenena o otimizador em silêncio). Aqui ele só LÊ, e o pior
// desfecho é uma tabela vazia com um aviso — por isso os dois não compartilham
// credencial, interruptor nem caminho de falha. A separação está justificada por
// extenso no cabeçalho da migration 0214.

/** As credenciais de leitura, já decifradas. */
export interface CredencialDeLeitura {
  accessToken: string;
  /** `act_<id>` que a tela abre por padrão. Nulo = ninguém escolheu ainda. */
  contaPadrao: string | null;
}

/**
 * Uma conta de anúncios alcançável pelo token.
 *
 * `moeda` não é enfeite: o token do dono do produto alcança contas em BRL, mas
 * nada impede uma conta em USD na mesma credencial. Formatar tudo em real
 * mostraria "R$ 364,63" para um gasto que foi em dólar — número errado, com
 * aparência de certo, que é o pior tipo de erro numa tela de custo.
 */
export interface ContaDeAnuncio {
  id: string;
  nome: string;
  moeda: string;
  /**
   * O `account_status` cru da plataforma (1 = ativa, 2 = desativada,
   * 3 = pendência de cobrança, …). Repassado em vez de virar booleano porque a
   * tela precisa DIZER qual é o problema: uma conta com cobrança pendente
   * devolve tabela vazia, e sem esta informação a tela pareceria quebrada.
   */
  status: number;
}

/**
 * O resultado de uma leitura, com a FÍSICA da falha declarada — não um `null`.
 *
 * Mesma doutrina do `ResultadoDeEnvio` acima (invariante 2: a origem da
 * restrição decide o que fazer quando ela barra), com os desfechos que ESTA
 * feature realmente tem:
 *
 *  - `token_invalido`         → alguém precisa colar um token novo. Códigos
 *                               190/102/463 da plataforma.
 *  - `permissao_insuficiente` → o token existe e vale, mas não tem `ads_read`
 *                               ou não alcança aquela conta. Códigos 10/200/272.
 *  - `limite_de_chamadas`     → cota. Resolve-se sozinho esperando, e a tela diz
 *                               em quanto tempo. Códigos 4/17/613/80000-80004.
 *  - `campo_invalido`         → código 100. NÃO é problema de quem opera: é bug
 *                               nosso, ou campo que a plataforma removeu da
 *                               versão que pedimos. Fica separado porque mandar
 *                               o operador "tentar de novo mais tarde" quando o
 *                               conserto é um deploy desperdiça o dia dele.
 *                               Foi assim que `video_3_sec_watched_actions`
 *                               apareceu: válido até a v21, erro 100 na v22.
 *  - `transitorio`            → rede, timeout, 5xx. Tentar de novo resolve.
 */
export type FalhaDeLeitura =
  | "token_invalido"
  | "permissao_insuficiente"
  | "limite_de_chamadas"
  | "campo_invalido"
  | "transitorio";

export type ResultadoDeLeitura<T> =
  | { ok: true; dados: T }
  | { ok: false; falha: FalhaDeLeitura; detalhe: string };

/**
 * O que a tela mostra de "Resultado", já resolvido.
 *
 * A plataforma devolve a MÉTRICA e o INDICADOR juntos (`results` traz
 * `indicator: "actions:onsite_conversion.messaging_conversation_started_7d"`),
 * e os dois viajam juntos até a tela de propósito: um "15" sozinho na coluna
 * Resultado não diz se são conversas, cadastros ou compras — e campanhas de
 * objetivos diferentes na mesma tabela tornam a coluna ilegível sem o rótulo.
 */
export interface ResultadoDaCampanha {
  /** Nulo quando a campanha não veiculou: a plataforma manda o indicador sem valor. */
  valor: number | null;
  custoPorResultado: number | null;
  /** O `indicator` cru, para o rótulo e para depuração. Nulo se nem ele veio. */
  indicador: string | null;
}

/**
 * Uma linha da tabela de campanhas — o formato da CASA, não o do fio.
 *
 * TUDO é nullable de propósito, e não por preguiça de tipagem: uma campanha sem
 * veiculação no período volta da plataforma sem `cpm`, sem `ctr`, sem `cpc` e
 * sem os campos de vídeo. Tipar como `number` obrigaria um `?? 0` na borda, e
 * "CTR 0,00%" é uma AFIRMAÇÃO FALSA — a campanha não teve CTR zero, ela não teve
 * medição. A tela mostra "—", que é a verdade.
 */
export interface LinhaDeCampanha {
  campanhaId: string;
  nome: string;
  /** `status` da campanha (ACTIVE/PAUSED/…). Nulo se ela sumiu entre as duas chamadas. */
  status: string | null;
  /** `effective_status` — a veiculação real, que difere do status quando o pai está pausado. */
  veiculacao: string | null;
  objetivo: string | null;
  resultado: ResultadoDaCampanha;
  gasto: number | null;
  impressoes: number | null;
  alcance: number | null;
  cpm: number | null;
  ctr: number | null;
  frequencia: number | null;
  cpc: number | null;
  /** Percentual já calculado (reproduções ÷ impressões × 100). Nulo em campanha sem vídeo. */
  hookRate: number | null;
  thruPlays: number | null;
}
