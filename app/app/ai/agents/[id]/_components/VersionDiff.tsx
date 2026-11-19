"use client";
/**
 * VersionDiff — diff side-by-side de duas versions (S-13.12).
 *
 * Implementação intencionalmente simples (sem `react-diff-viewer`):
 *   - Tools: pills added/removed.
 *   - Provider/model/limits: lista de mudanças key→A/B.
 *   - System prompt: diff naive linha-a-linha (LCS via dynamic programming
 *     pequeno) com marcadores `+`/`-`/` `.
 */
import * as React from "react";

import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { textoEstavel } from "@/lib/ai/agents/mesmo-rascunho";
import { catalogEntry } from "@/lib/mcp/tools/catalogo";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

interface Props {
  versionA: AgentVersionRow; // mais antiga / base
  versionB: AgentVersionRow; // mais nova / candidata
  /** Para nomear os materiais e funis que entram ou saem, em vez do id. */
  materiais?: ReadonlyArray<{ id: string; name: string }>;
  funis?: ReadonlyArray<{ id: string; name: string }>;
}

type DiffLine = { kind: "ctx" | "add" | "del"; text: string };

function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const m = A.length;
  const n = B.length;
  // LCS DP — capped to keep us safe on huge prompts (rare here).
  const CAP = 600;
  if (m > CAP || n > CAP) {
    return [
      { kind: "del", text: a },
      { kind: "add", text: b },
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      row[j] = A[i] === B[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ kind: "ctx", text: A[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: A[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: B[j]! });
      j++;
    }
  }
  while (i < m) out.push({ kind: "del", text: A[i++]! });
  while (j < n) out.push({ kind: "add", text: B[j++]! });
  return out;
}

function diffArr(prev: string[], next: string[]) {
  const added = next.filter((x) => !prev.includes(x));
  const removed = prev.filter((x) => !next.includes(x));
  return { added, removed };
}

interface FieldChange {
  key: string;
  label: string;
  a: string;
  b: string;
}

type Formato = "texto" | "provedor" | "simnao" | "dolar" | "segundos" | "opaco";

/**
 * Os MESMOS rótulos da Configuração. Antes a tabela dizia `max_steps`,
 * `Provider` e `true`/`false`, e ignorava horário — quem só mudou o horário
 * via "Sem mudanças".
 */
const CAMPOS: ReadonlyArray<[keyof AgentVersionRow, string, Formato]> = [
  ["provider", "Empresa", "provedor"],
  ["model", "Modelo", "texto"],
  ["credential_id", "Chave de acesso", "opaco"],
  ["channel_session_id", "Número do WhatsApp", "opaco"],
  ["max_steps", "Ações por atendimento (1 a 25)", "texto"],
  ["token_budget", "Volume de texto por atendimento", "texto"],
  ["cost_budget_cents", "Custo máximo por atendimento (centavos de dólar)", "dolar"],
  ["history_message_window", "Mensagens anteriores que ele lê", "texto"],
  ["history_token_window", "Tamanho máximo desse histórico", "texto"],
  ["reply_min_interval_ms", "Pausa entre uma resposta e a próxima (segundos)", "segundos"],
  ["split_messages", "Responder em várias mensagens curtas (como uma pessoa digita)", "simnao"],
  ["split_max_chars", "Tamanho máximo por bolha (80–4000)", "texto"],
  ["handoff_tool_enabled", "Deixar o agente chamar uma pessoa quando perceber que não é caso dele", "simnao"],
  ["cases_enabled", "Deixar o agente pedir uma tarefa a alguém e seguir conversando", "simnao"],
];

function formatar(v: unknown, f: Formato): string {
  if (v == null || v === "") return "—";
  switch (f) {
    case "provedor":
      return PROVEDORES.find((p) => p.id === v)?.rotulo ?? String(v);
    case "simnao":
      return v ? "Sim" : "Não";
    case "dolar":
      return `US$ ${(Number(v) / 100).toFixed(2).replace(".", ",")}`;
    case "segundos":
      return String(Number(v) / 1000).replace(".", ",");
    case "opaco":
      return "mudou";
    default:
      return String(v);
  }
}

const horarioDe = (v: AgentVersionRow) =>
  (v.trigger_config as { filters?: { business_hours?: unknown } } | null)?.filters?.business_hours ??
  null;

function buildFieldChanges(a: AgentVersionRow, b: AgentVersionRow): FieldChange[] {
  const out: FieldChange[] = CAMPOS.filter(([k]) => a[k] !== b[k]).map(([k, label, f]) => ({
    key: k as string,
    label,
    a: f === "opaco" ? "" : formatar(a[k], f),
    b: formatar(b[k], f),
  }));
  if (textoEstavel(horarioDe(a)) !== textoEstavel(horarioDe(b))) {
    out.push({ key: "business_hours", label: "Horário de atendimento", a: "", b: "mudou" });
  }
  return out;
}

export function VersionDiff({ versionA, versionB, materiais = [], funis = [] }: Props) {
  const t = useT();
  const nome = (lista: ReadonlyArray<{ id: string; name: string }>) => (id: string) =>
    lista.find((x) => x.id === id)?.name ?? t("(fora da lista)");
  const rotuloDaAcao = (id: string) => {
    const r = catalogEntry(id)?.rotulo;
    return r ? t(r) : id;
  };
  const tools = diffArr(versionA.tool_ids ?? [], versionB.tool_ids ?? []);
  const mats = diffArr(versionA.knowledge_source_ids ?? [], versionB.knowledge_source_ids ?? []);
  const funs = diffArr(versionA.pipeline_ids ?? [], versionB.pipeline_ids ?? []);
  const handoffKw = diffArr(versionA.handoff_keywords ?? [], versionB.handoff_keywords ?? []);
  const followupFlows = diffArr(
    versionA.followup?.flow_pointer_ids ?? [],
    versionB.followup?.flow_pointer_ids ?? [],
  );
  const followupEnabledChanged =
    (versionA.followup?.enabled ?? false) !== (versionB.followup?.enabled ?? false);
  const fields = buildFieldChanges(versionA, versionB);
  const lines = diffLines(versionA.system_prompt ?? "", versionB.system_prompt ?? "");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="outline">v{versionA.version_number}</Badge>
        <span className="text-muted-foreground">→</span>
        <Badge variant="outline">v{versionB.version_number}</Badge>
      </div>

      <Section title={t("Configuração")}>
        {fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Sem mudanças.")}</p>
        ) : (
          // `overflow-x-auto` isolado: campos como `channel_session_id`
          // (uuid, monoespaçado) em 3 colunas passavam da largura de um
          // celular pequeno sem isso.
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3">{t("Campo")}</th>
                  <th className="py-1 pr-3">v{versionA.version_number}</th>
                  <th className="py-1">v{versionB.version_number}</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.key} className="border-t border-border/40">
                    <td className="py-1 pr-3">{t(f.label)}</td>
                    <td className="whitespace-nowrap py-1 pr-3 text-destructive">{f.a ? t(f.a) : ""}</td>
                    <td className="whitespace-nowrap py-1 text-success-fg">{t(f.b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={t("O que o agente pode fazer")}>
        <Pills label={t("Adicionadas")} tone="add" items={tools.added.map(rotuloDaAcao)} />
        <Pills label={t("Removidas")} tone="del" items={tools.removed.map(rotuloDaAcao)} />
        {tools.added.length === 0 && tools.removed.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Sem mudanças.")}</p>
        ) : null}
      </Section>

      <Section title={t("Materiais")}>
        <Pills label={t("Adicionadas")} tone="add" items={mats.added.map(nome(materiais))} />
        <Pills label={t("Removidas")} tone="del" items={mats.removed.map(nome(materiais))} />
        {mats.added.length === 0 && mats.removed.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Sem mudanças.")}</p>
        ) : null}
      </Section>

      <Section title={t("Funis")}>
        <Pills label={t("Adicionadas")} tone="add" items={funs.added.map(nome(funis))} />
        <Pills label={t("Removidas")} tone="del" items={funs.removed.map(nome(funis))} />
        {funs.added.length === 0 && funs.removed.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Sem mudanças.")}</p>
        ) : null}
      </Section>

      <Section title={t("Palavras que chamam uma pessoa na hora")}>
        <Pills label={t("Adicionadas")} tone="add" items={handoffKw.added} />
        <Pills label={t("Removidas")} tone="del" items={handoffKw.removed} />
        {handoffKw.added.length === 0 && handoffKw.removed.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Sem mudanças.")}</p>
        ) : null}
      </Section>

      <Section title={t("Follow-up")}>
        {followupEnabledChanged ? (
          <p className="text-xs">
            {t("Ligado")}:{" "}
            <span className="text-destructive">
              {t(versionA.followup?.enabled ? "Sim" : "Não")}
            </span>{" "}
            →{" "}
            <span className="text-success-fg">
              {t(versionB.followup?.enabled ? "Sim" : "Não")}
            </span>
          </p>
        ) : null}
        <Pills label={t("Fluxos adicionados")} tone="add" items={followupFlows.added} />
        <Pills label={t("Fluxos removidos")} tone="del" items={followupFlows.removed} />
        {!followupEnabledChanged &&
        followupFlows.added.length === 0 &&
        followupFlows.removed.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Sem mudanças.")}</p>
        ) : null}
      </Section>

      <Section title={t("As instruções dele")}>
        <pre className="max-h-96 overflow-auto rounded-md border border-border/60 bg-muted/30 p-2 font-mono text-xs leading-relaxed">
          {lines.map((l, idx) => {
            const cls =
              l.kind === "add"
                ? "block bg-success-bg text-success-fg"
                : l.kind === "del"
                  ? "block bg-destructive/10 text-destructive"
                  : "block";
            const prefix = l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  ";
            return (
              <span key={idx} className={cls}>
                {prefix}
                {l.text || " "}
              </span>
            );
          })}
        </pre>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="rotulo-secao text-muted-foreground">
        {title}
      </h4>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Pills({
  label,
  tone,
  items,
}: {
  label: string;
  tone: "add" | "del";
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {items.map((id, i) => (
        <Badge
          key={`${id}-${i}`}
          variant="outline"
          className={
            tone === "add"
              ? "border-success/40 bg-success-bg text-success-fg"
              : "border-destructive/40 bg-destructive/10 text-destructive"
          }
        >
          {tone === "add" ? "+ " : "− "}
          {id}
        </Badge>
      ))}
    </div>
  );
}
