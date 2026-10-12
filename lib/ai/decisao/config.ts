/**
 * A CONFIGURAÇÃO DO JEV, em `organizations.settings.jev`.
 *
 * Porte enxuto de melgarafael/DeskcommCRM #1575/#1696 (`config.ts`), com as
 * chaves do upstream para um porte futuro não precisar migrar dado.
 *
 * Cada tarefa está `observando` ou `desligada`. As duas de pedido do cliente
 * (`humano`, `opt_out`) aceitam um terceiro estado, `decidindo`, que na tela se
 * chama "Avisar a equipe" (porte de #1747): o pedido percebido abre um aviso na
 * Central, e é tudo (`./aviso-a-equipe.ts`). O clima NÃO aceita `decidindo`:
 * gravado à mão no banco, ele é lido como `desligada`.
 *
 * Regras que valem em qualquer leitura:
 *  - interruptor desligado, ou sem o aceite do administrador → tudo desligado;
 *  - config ilegível → tudo desligado (o lado seguro);
 *  - tarefa sem estado gravado, com o Jev ligado e aceito → `observando`.
 */
import { z } from "zod";

export const TAREFAS_DO_JEV = ["clima", "humano", "opt_out"] as const;
export type IdDaTarefa = (typeof TAREFAS_DO_JEV)[number];

export const ESTADOS_DA_TAREFA = ["observando", "decidindo", "desligada"] as const;
export type EstadoDaTarefa = (typeof ESTADOS_DA_TAREFA)[number];

/** As únicas que podem ficar em `decidindo` ("Avisar a equipe"). O clima, não. */
export const TAREFAS_QUE_AVISAM: readonly IdDaTarefa[] = ["humano", "opt_out"];

export function estadosPermitidos(tarefa: IdDaTarefa): readonly EstadoDaTarefa[] {
  return TAREFAS_QUE_AVISAM.includes(tarefa) ? ESTADOS_DA_TAREFA : ["observando", "desligada"];
}

const estadoDe = (tarefa: IdDaTarefa) =>
  z.custom<EstadoDaTarefa>((v) => (estadosPermitidos(tarefa) as readonly unknown[]).includes(v));

/** O que a rota aceita gravar por tarefa: `decidindo` no clima é recusado aqui. */
export const estadosDasTarefasSchema = z
  .object({ clima: estadoDe("clima"), humano: estadoDe("humano"), opt_out: estadoDe("opt_out") })
  .partial()
  .strict();

const tarefaGravada = (tarefa: IdDaTarefa) =>
  z
    .object({
      estado: estadoDe(tarefa),
      alterado_em: z.string().optional(),
      alterado_por: z.string().optional(),
    })
    .optional()
    .catch({ estado: "desligada" as const });

export const configDoJevSchema = z.object({
  ligado: z.boolean().default(false),
  /** Quem aceitou mandar a mensagem, limpa, ao fornecedor estrangeiro, e quando. */
  aceite: z.object({ em: z.string(), por: z.string() }).nullable().default(null),
  tarefas: z
    .object({ clima: tarefaGravada("clima"), humano: tarefaGravada("humano"), opt_out: tarefaGravada("opt_out") })
    .partial()
    .optional(),
  alterado_em: z.string().optional(),
  alterado_por: z.string().optional(),
});
export type ConfigDoJev = z.infer<typeof configDoJevSchema>;

const DESLIGADO: ConfigDoJev = { ligado: false, aceite: null };

export function lerConfigDoJev(settings: unknown): ConfigDoJev {
  const bruto =
    settings !== null && typeof settings === "object" ? (settings as Record<string, unknown>).jev : undefined;
  const lido = configDoJevSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : { ...DESLIGADO };
}

export function estadoEfetivo(config: ConfigDoJev, tarefa: IdDaTarefa): EstadoDaTarefa {
  if (!config.ligado || config.aceite === null) return "desligada";
  return config.tarefas?.[tarefa]?.estado ?? "observando";
}

export interface MudancaDaConfig {
  ligado?: boolean;
  /** `true` grava o aceite de quem está pedindo; não há como desfazer o aceite sem desligar. */
  aceitar?: boolean;
  tarefas?: Partial<Record<IdDaTarefa, EstadoDaTarefa>>;
}

/**
 * Aplica a mudança, carimbando quem e quando. Ligar sem aceite (gravado antes
 * ou neste mesmo pedido) é recusado: cadastrar a chave não é consentir.
 */
export function aplicarMudanca(
  atual: ConfigDoJev,
  m: MudancaDaConfig,
  quem: string,
  agora: Date,
): { ok: true; config: ConfigDoJev } | { ok: false; motivo: "aceite_ausente" } {
  const em = agora.toISOString();
  const aceite = m.aceitar === true ? { em, por: quem } : atual.aceite;
  const ligado = m.ligado ?? atual.ligado;
  if (ligado && aceite === null) return { ok: false, motivo: "aceite_ausente" };
  const tarefas = { ...(atual.tarefas ?? {}) };
  for (const [id, estado] of Object.entries(m.tarefas ?? {}) as Array<[IdDaTarefa, EstadoDaTarefa]>) {
    tarefas[id] = { estado, alterado_em: em, alterado_por: quem };
  }
  return { ok: true, config: { ligado, aceite, tarefas, alterado_em: em, alterado_por: quem } };
}
