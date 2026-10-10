/**
 * A CONFIGURAÇÃO DO JEV, em `organizations.settings.jev`.
 *
 * Porte enxuto de melgarafael/DeskcommCRM #1575/#1696 (`config.ts`), com as
 * chaves do upstream para um porte futuro não precisar migrar dado.
 *
 * Fase 1 (observando): cada tarefa só pode estar `observando` ou `desligada`.
 * Nenhuma decide nada. O estado `decidindo` do upstream fica fora do schema de
 * propósito: gravado à mão no banco, ele é lido como `desligada`.
 *
 * Regras que valem em qualquer leitura:
 *  - interruptor desligado, ou sem o aceite do administrador → tudo desligado;
 *  - config ilegível → tudo desligado (o lado seguro);
 *  - tarefa sem estado gravado, com o Jev ligado e aceito → `observando`.
 */
import { z } from "zod";

export const TAREFAS_DO_JEV = ["clima", "humano", "opt_out"] as const;
export type IdDaTarefa = (typeof TAREFAS_DO_JEV)[number];

export const ESTADOS_DA_TAREFA = ["observando", "desligada"] as const;
export type EstadoDaTarefa = (typeof ESTADOS_DA_TAREFA)[number];

const tarefaGravada = z
  .object({
    estado: z.enum(ESTADOS_DA_TAREFA),
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
    .object({ clima: tarefaGravada, humano: tarefaGravada, opt_out: tarefaGravada })
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
