"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { type RegrasDoBonus, regrasSchema } from "@/lib/bonus/regras";
import type { RespostaDoPrograma } from "@/lib/bonus/tela";
import { CHAVES_DE_RESULTADO } from "@/lib/bonus/tipos";

import { ROTULO_DO_CRITERIO } from "./MeuBonus";

interface Membro {
  user_id: string;
  full_name: string | null;
}

/** Texto do campo para número. Vazio ou torto vira NaN, e o esquema aponta o campo. */
const numero = (texto: string) => (texto.trim() === "" ? Number.NaN : Number(texto.replace(",", ".")));
const reais = (cents: number | null) => (cents === null || Number.isNaN(cents) ? "" : String(cents / 100));
const centavos = (texto: string) => Math.round(numero(texto) * 100);
const porcento = (bps: number) => (Number.isNaN(bps) ? "" : String(bps / 100));
const bps = (texto: string) => Math.round(numero(texto) * 100);
const texto = (n: number) => (Number.isNaN(n) ? "" : String(n));
const METAS_VAZIAS = () => ({
  comparecimento: { basica: 0, alta: 0 },
  sinal_pago: { basica: 0, alta: 0 },
  avaliacao_google: { basica: 0, alta: 0 },
});

/**
 * O campo guarda o TEXTO digitado; a regra guarda o número. Assim apagar o
 * campo para redigitar não faz um "0" reaparecer embaixo do cursor.
 */
function Campo({
  id,
  rotulo,
  valor,
  aoMudar,
  invalido = false,
  tipo = "number",
}: {
  id: string;
  rotulo: string;
  valor: string;
  aoMudar: (v: string) => void;
  invalido?: boolean;
  tipo?: string;
}) {
  const [atual, setAtual] = useState(valor);
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{rotulo}</Label>
      <Input
        id={id}
        type={tipo}
        inputMode={tipo === "number" ? "decimal" : undefined}
        aria-invalid={invalido || undefined}
        className={invalido ? "border-destructive" : undefined}
        value={atual}
        onChange={(e) => {
          setAtual(e.target.value);
          aoMudar(e.target.value);
        }}
      />
    </div>
  );
}

export function ConfiguracaoDoBonus() {
  const t = useT();
  const programa = useQuery({
    queryKey: ["bonus", "programa"],
    queryFn: () => apiClient.get<{ data: RespostaDoPrograma }>("/api/v1/bonus/programa"),
  });
  const equipe = useQuery({
    queryKey: ["team", "assignable"],
    queryFn: () => apiClient.get<{ data: Membro[] }>("/api/v1/team/assignable"),
  });
  const p = programa.data?.data.programa;
  if (programa.isError) return <p className="text-sm text-destructive">{t("Não foi possível carregar a configuração.")}</p>;
  if (!p || equipe.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando a configuração…")}</p>;
  // O formulário só nasce com a regra em mãos: estado inicial sem efeito de sincronização.
  return <Formulario inicial={p.regras} aprovador={p.aprovador_user_id} membros={equipe.data?.data ?? []} />;
}

function Formulario({ inicial, aprovador, membros }: { inicial: RegrasDoBonus; aprovador: string; membros: Membro[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [r, setR] = useState<RegrasDoBonus>(inicial);
  const [mesDaMeta, setMesDaMeta] = useState("");
  const [novoAprovador, setNovoAprovador] = useState("");
  const [feriados, setFeriados] = useState(inicial.feriados.join("\n"));

  const salvar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) => apiClient.put("/api/v1/bonus/programa", corpo),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bonus"] }),
  });

  const muda = (f: (x: RegrasDoBonus) => RegrasDoBonus) => setR((x) => f(structuredClone(x)));
  const candidato = { ...r, feriados: feriados.split("\n").map((l) => l.trim()).filter(Boolean) };
  // A mesma régua da rota, na tela: o campo errado fica marcado antes de salvar.
  const conferido = regrasSchema.safeParse(candidato);
  const invalidos = new Set(conferido.success ? [] : conferido.error.issues.map((i) => i.path.join(".")));
  const errado = (caminho: string) => [...invalidos].some((c) => c === caminho || c.startsWith(`${caminho}.`));
  const meta = mesDaMeta ? r.metas_por_mes[mesDaMeta] : undefined;
  const idsDaEquipe = new Set(membros.map((m) => m.user_id));
  // Quem saiu da equipe continua na regra até alguém tirar: sem isto o PUT
  // recusa a configuração inteira ("um dos participantes não faz parte").
  const foraDaEquipe = r.participantes.filter((id) => !idsDaEquipe.has(id));
  const tirar = (id: string) => muda((x) => ({ ...x, participantes: x.participantes.filter((p) => p !== id) }));

  const erroDoSalvar = salvar.error instanceof ApiError ? salvar.error.message : t("Não foi possível salvar. Confira os campos.");

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="configuracao-do-bonus">
      <Card>
        <CardHeader>
          <CardTitle>{t("Participantes")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {membros.map((m) => (
            <label key={m.user_id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={r.participantes.includes(m.user_id)}
                onChange={(e) =>
                  e.target.checked ? muda((x) => ({ ...x, participantes: [...x.participantes, m.user_id] })) : tirar(m.user_id)
                }
              />
              {m.full_name ?? t("Sem nome")}
            </label>
          ))}
          {foraDaEquipe.map((id) => (
            <div key={id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2" data-testid="fora-da-equipe">
              <span className="text-sm">{t("Pessoa que saiu da equipe")}</span>
              <Button size="sm" variant="outline" onClick={() => tirar(id)}>
                {t("Tirar do programa")}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Valores")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <Campo
            id="teto"
            rotulo={t("Teto por pessoa (R$, vazio para sem teto)")}
            valor={reais(r.teto_cents)}
            invalido={errado("teto_cents")}
            aoMudar={(v) => muda((x) => ({ ...x, teto_cents: v.trim() === "" ? null : centavos(v) }))}
          />
          <Campo
            id="tarefas"
            rotulo={t("Tarefas, valor cheio (R$)")}
            valor={reais(r.tarefas.valor_cents)}
            invalido={errado("tarefas.valor_cents")}
            aoMudar={(v) => muda((x) => ({ ...x, tarefas: { ...x.tarefas, valor_cents: centavos(v) } }))}
          />
          {CHAVES_DE_RESULTADO.map((chave) => (
            <Campo
              key={chave}
              id={`valor-${chave}`}
              rotulo={t("{criterio} (R$)").replace("{criterio}", t(ROTULO_DO_CRITERIO[chave]))}
              valor={reais(r.resultados[chave].valor_cents)}
              invalido={errado(`resultados.${chave}`)}
              aoMudar={(v) => muda((x) => ({ ...x, resultados: { ...x.resultados, [chave]: { valor_cents: centavos(v) } } }))}
            />
          ))}
          {r.tarefas.faixas.map((f, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 md:col-span-2">
              <Campo
                id={`faixa-min-${i}`}
                rotulo={t("Faixa {n}: a partir de (%)").replace("{n}", String(i + 1))}
                valor={porcento(f.minimo_bps)}
                invalido={errado(`tarefas.faixas.${i}.minimo_bps`)}
                aoMudar={(v) =>
                  muda((x) => {
                    x.tarefas.faixas[i]!.minimo_bps = bps(v);
                    return x;
                  })
                }
              />
              <Campo
                id={`faixa-fr-${i}`}
                rotulo={t("Faixa {n}: paga (%)").replace("{n}", String(i + 1))}
                valor={porcento(f.fracao_bps)}
                invalido={errado(`tarefas.faixas.${i}.fracao_bps`)}
                aoMudar={(v) =>
                  muda((x) => {
                    x.tarefas.faixas[i]!.fracao_bps = bps(v);
                    return x;
                  })
                }
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Metas por mês")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Campo id="mes-da-meta" tipo="month" rotulo={t("Mês")} valor={mesDaMeta} aoMudar={setMesDaMeta} />
          {mesDaMeta ? (
            // A chave pelo mês remonta os campos: cada mês abre com os números dele.
            <div key={mesDaMeta} className="flex flex-col gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(r.meses_de_teste[mesDaMeta])}
                  onChange={(e) =>
                    muda((x) => {
                      if (e.target.checked) x.meses_de_teste[mesDaMeta] = { garantia_resultados_cents: 0 };
                      else delete x.meses_de_teste[mesDaMeta];
                      return x;
                    })
                  }
                />
                {t("Mês de teste (resultados garantidos)")}
              </label>
              {r.meses_de_teste[mesDaMeta] ? (
                <Campo
                  id="garantia"
                  rotulo={t("Garantia dos resultados (R$)")}
                  valor={reais(r.meses_de_teste[mesDaMeta]!.garantia_resultados_cents)}
                  invalido={errado(`meses_de_teste.${mesDaMeta}`)}
                  aoMudar={(v) =>
                    muda((x) => {
                      x.meses_de_teste[mesDaMeta] = { garantia_resultados_cents: centavos(v) };
                      return x;
                    })
                  }
                />
              ) : null}
              {CHAVES_DE_RESULTADO.map((chave) => (
                <div key={chave} className="grid grid-cols-2 gap-2">
                  {(["basica", "alta"] as const).map((nivel) => (
                    <Campo
                      key={nivel}
                      id={`${nivel}-${chave}`}
                      rotulo={`${t(ROTULO_DO_CRITERIO[chave])} · ${nivel === "basica" ? t("Meta básica") : t("Meta alta")}`}
                      valor={meta ? texto(meta[chave][nivel]) : ""}
                      invalido={errado(`metas_por_mes.${mesDaMeta}.${chave}`)}
                      aoMudar={(v) =>
                        muda((x) => {
                          const atual = x.metas_por_mes[mesDaMeta] ?? METAS_VAZIAS();
                          atual[chave][nivel] = numero(v);
                          x.metas_por_mes[mesDaMeta] = atual;
                          return x;
                        })
                      }
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("Escolha o mês para ver e mudar as metas dele.")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Rotinas e fila")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Campo id="leads-dia" rotulo={t("Leads antigos por dia")} valor={texto(r.rotinas.leads_por_dia)} invalido={errado("rotinas.leads_por_dia")} aoMudar={(v) => muda((x) => ({ ...x, rotinas: { ...x.rotinas, leads_por_dia: numero(v) } }))} />
          <Campo id="lig-dia" rotulo={t("Ligações por dia")} valor={texto(r.rotinas.ligacoes_por_dia)} invalido={errado("rotinas.ligacoes_por_dia")} aoMudar={(v) => muda((x) => ({ ...x, rotinas: { ...x.rotinas, ligacoes_por_dia: numero(v) } }))} />
          <Campo id="stories-dia" rotulo={t("Stories por dia")} valor={texto(r.rotinas.stories_por_dia)} invalido={errado("rotinas.stories_por_dia")} aoMudar={(v) => muda((x) => ({ ...x, rotinas: { ...x.rotinas, stories_por_dia: numero(v) } }))} />
          <Campo id="hora" rotulo={t("Hora da fila")} valor={texto(r.fila.hora_local)} invalido={errado("fila.hora_local")} aoMudar={(v) => muda((x) => ({ ...x, fila: { ...x.fila, hora_local: numero(v) } }))} />
          <Campo id="sem-msg" rotulo={t("Dias sem mensagem")} valor={texto(r.fila.dias_sem_mensagem)} invalido={errado("fila.dias_sem_mensagem")} aoMudar={(v) => muda((x) => ({ ...x, fila: { ...x.fila, dias_sem_mensagem: numero(v) } }))} />
          <Campo id="sem-repetir" rotulo={t("Dias sem repetir o contato")} valor={texto(r.fila.dias_sem_repetir)} invalido={errado("fila.dias_sem_repetir")} aoMudar={(v) => muda((x) => ({ ...x, fila: { ...x.fila, dias_sem_repetir: numero(v) } }))} />
          <Campo id="etiqueta" tipo="text" rotulo={t("Etiqueta que tira da fila")} valor={r.fila.etiqueta_excluida} invalido={errado("fila.etiqueta_excluida")} aoMudar={(v) => muda((x) => ({ ...x, fila: { ...x.fila, etiqueta_excluida: v } }))} />
          <Campo id="limite" rotulo={t("Limite de pedidos para parar (%)")} valor={porcento(r.protecao.limite_bps)} invalido={errado("protecao.limite_bps")} aoMudar={(v) => muda((x) => ({ ...x, protecao: { ...x.protecao, limite_bps: bps(v) } }))} />
          <Campo id="dias-seguidos" rotulo={t("Dias seguidos acima do limite")} valor={texto(r.protecao.dias_seguidos)} invalido={errado("protecao.dias_seguidos")} aoMudar={(v) => muda((x) => ({ ...x, protecao: { ...x.protecao, dias_seguidos: numero(v) } }))} />
          <Campo id="fracao-reduzida" rotulo={t("Fila reduzida a (%)")} valor={porcento(r.protecao.fracao_reduzida_bps)} invalido={errado("protecao.fracao_reduzida_bps")} aoMudar={(v) => muda((x) => ({ ...x, protecao: { ...x.protecao, fracao_reduzida_bps: bps(v) } }))} />
          <Campo id="intervalo" rotulo={t("Intervalo mínimo entre mensagens da fila (segundos)")} valor={texto(r.protecao.intervalo_minimo_s)} invalido={errado("protecao.intervalo_minimo_s")} aoMudar={(v) => muda((x) => ({ ...x, protecao: { ...x.protecao, intervalo_minimo_s: numero(v) } }))} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Pacientes para ligar")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Campo id="lig-falta" rotulo={t("Faltas dos últimos (dias)")} valor={texto(r.fila.ligacoes.dias_falta)} invalido={errado("fila.ligacoes.dias_falta")} aoMudar={(v) => muda((x) => ({ ...x, fila: { ...x.fila, ligacoes: { ...x.fila.ligacoes, dias_falta: numero(v) } } }))} />
          <Campo id="lig-pos" rotulo={t("Pós-consulta dos últimos (dias)")} valor={texto(r.fila.ligacoes.dias_pos_consulta)} invalido={errado("fila.ligacoes.dias_pos_consulta")} aoMudar={(v) => muda((x) => ({ ...x, fila: { ...x.fila, ligacoes: { ...x.fila.ligacoes, dias_pos_consulta: numero(v) } } }))} />
          <Campo id="lig-ret-min" rotulo={t("Sem retorno há pelo menos (dias)")} valor={texto(r.fila.ligacoes.dias_retorno_min)} invalido={errado("fila.ligacoes.dias_retorno_min")} aoMudar={(v) => muda((x) => ({ ...x, fila: { ...x.fila, ligacoes: { ...x.fila.ligacoes, dias_retorno_min: numero(v) } } }))} />
          <Campo id="lig-ret-max" rotulo={t("Sem retorno há no máximo (dias)")} valor={texto(r.fila.ligacoes.dias_retorno_max)} invalido={errado("fila.ligacoes.dias_retorno_max")} aoMudar={(v) => muda((x) => ({ ...x, fila: { ...x.fila, ligacoes: { ...x.fila.ligacoes, dias_retorno_max: numero(v) } } }))} />
          <Campo id="lig-sem-repetir" rotulo={t("Dias sem repetir a ligação")} valor={texto(r.fila.ligacoes.dias_sem_repetir)} invalido={errado("fila.ligacoes.dias_sem_repetir")} aoMudar={(v) => muda((x) => ({ ...x, fila: { ...x.fila, ligacoes: { ...x.fila.ligacoes, dias_sem_repetir: numero(v) } } }))} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Feriados")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <Label htmlFor="feriados">{t("Feriados (um por linha, AAAA-MM-DD)")}</Label>
          <Textarea
            id="feriados"
            aria-invalid={errado("feriados") || undefined}
            className={errado("feriados") ? "min-h-24 border-destructive" : "min-h-24"}
            value={feriados}
            onChange={(e) => setFeriados(e.target.value)}
          />
        </CardContent>
      </Card>

      {!conferido.success ? <p className="text-sm text-destructive">{t("Confira os campos marcados em vermelho.")}</p> : null}
      {salvar.isError ? <p className="text-sm text-destructive">{erroDoSalvar}</p> : null}
      {salvar.isSuccess ? <p className="text-sm text-muted-foreground">{t("Configuração salva.")}</p> : null}
      <Button className="self-start" disabled={salvar.isPending || !conferido.success} onClick={() => salvar.mutate({ regras: candidato })}>
        {t("Salvar configuração")}
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>{t("Passar a função de aprovador")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {t("Quem aprova não pode ser tirado da instalação. Para isso, passe a função a outra pessoa antes.")}
          </p>
          <select
            aria-label={t("Novo aprovador")}
            className="rounded-md border border-border bg-surface p-2"
            value={novoAprovador}
            onChange={(e) => setNovoAprovador(e.target.value)}
          >
            <option value="">{t("Escolha uma pessoa")}</option>
            {membros
              .filter((m) => m.user_id !== aprovador)
              .map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name ?? t("Sem nome")}
                </option>
              ))}
          </select>
          <Button
            variant="outline"
            className="self-start"
            disabled={!novoAprovador || salvar.isPending}
            onClick={() => {
              if (window.confirm(t("Depois disso, só a nova pessoa vê e muda a configuração. Confirma?"))) {
                salvar.mutate({ aprovador_user_id: novoAprovador }, { onSuccess: () => window.location.reload() });
              }
            }}
          >
            {t("Passar a função")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
