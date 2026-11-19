"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty/EmptyState";
import { Key } from "@/lib/ui/icons";

import {
  useApiTokens,
  useApiTokensTemporarias,
  useCreateApiToken,
  useRevokeApiToken,
  type ApiTokenRow,
  type CreatedApiToken,
} from "@/hooks/team/useApiTokens";
import { copyToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";

/**
 * `mcp:read`/`mcp:write` faltavam nesta lista, e sem eles NENHUMA ferramenta
 * MCP funciona: toda chamada volta "Token missing required scope 'mcp:read'"
 * (lib/mcp/types.ts exige um dos dois em cada tool). Como esta tela é o único
 * lugar que emite token, o "CRM operável por agentes de IA via MCP" ficava
 * inalcançável — a API sempre aceitou os escopos; só o catálogo daqui os
 * escondia.
 */
/** Escopos de agenda cuja tool exige o papel ai_operator; sem ele a chave nasce inútil. */
const PEDEM_OPERADOR = ["agenda:reschedule", "agenda:outcome"];

const SCOPES: { id: string; label: string }[] = [
  { id: "prontuario:contacts:read", label: "Prontuário: pesquisar cadastro de contatos" },
  { id: "prontuario:contacts:demographics:read", label: "Prontuário: importar CPF e endereço do CRM (requer leitura de contatos)" },
  { id: "prontuario:contacts:write", label: "Prontuário: criar e atualizar cadastro de contatos" },
  // Só as duas rotas de mídia do Prontuário aceitam: não abre MCP nem conversas.
  { id: "prontuario:media:read", label: "Prontuário: baixar PDF e fotos que o paciente mandou pelo WhatsApp" },
  { id: "agenda:read", label: "Prontuário: ler compromissos da agenda" },
  { id: "agenda:reschedule", label: "Prontuário: remarcar compromissos da agenda" },
  // Só "Realizado": não registra falta, não remarca, não cancela (migration 0401).
  { id: "prontuario:funil", label: "Prontuário: alimentar o funil (funis, etapas e leads)" },
  { id: "agenda:outcome", label: "Prontuário: marcar compromisso como realizado (requer operador de agenda)" },
  { id: "role:ai_operator", label: "Operador de agenda (necessário para remarcar ou marcar como realizado)" },
  // Só a rota do Financeiro aceita: não abre MCP nem conversas.
  { id: "financeiro:contatos", label: "Financeiro: ler nome, telefone e e-mail de um contato" },
  { id: "mcp:read", label: "Agentes de IA podem LER o CRM (MCP)" },
  { id: "mcp:write", label: "Agentes de IA podem AGIR no CRM (MCP)" },
  // Sem isto o token nasce como 'agent' e as ferramentas de nível gerente
  // (criar lead, atribuir conversa) respondem "Role 'agent' insufficient".
  // O papel viaja junto dos escopos (ver lib/mcp/auth.ts) e também não
  // aparecia em lugar nenhum da interface.
  { id: "role:manager", label: "Tratar o token como gerente (necessário p/ criar e atribuir)" },
  { id: "contacts:read", label: "Ler contatos" },
  { id: "contacts:write", label: "Criar e editar contatos" },
  { id: "leads:read", label: "Ler leads" },
  { id: "leads:write", label: "Criar e editar leads" },
  { id: "messages:read", label: "Ler mensagens" },
  { id: "messages:write", label: "Enviar mensagens" },
  { id: "audit:read", label: "Ler o log de auditoria" },
];

export function ApiTokensClient() {
  const t = useT();
  const { data, isLoading, isError } = useApiTokens();
  const create = useCreateApiToken();
  const revoke = useRevokeApiToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<string>("");
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  const tokens = data?.data ?? [];
  const temporariasTotal = data?.meta?.temporarias_da_ia ?? 0;
  const [temporariasAbertas, setTemporariasAbertas] = useState(false);
  const temporarias = useApiTokensTemporarias(temporariasAbertas);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (scopes.length === 0) {
      toast.error(t("Escolha ao menos uma permissão."));
      return;
    }
    try {
      const res = await create.mutateAsync({
        name,
        scopes,
        expires_in_days: expiresInDays ? Number(expiresInDays) : undefined,
      });
      setCreated(res.data);
      setName("");
      setScopes([]);
      setExpiresInDays("");
      setCreateOpen(false);
    } catch {
      /* noop */
    }
  };

  const faltaOperador = scopes.some((s) => PEDEM_OPERADOR.includes(s)) && !scopes.includes("role:ai_operator");

  const toggleScope = (s: string) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return (
    <>
      <div className="flex sm:justify-end">
        <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
          {t("Criar chave")}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : isError ? (
        // Falha não é "nenhuma chave": quem administra criaria outra à toa.
        <p className="text-sm text-muted-foreground" role="alert">{t("Não foi possível carregar as chaves. Recarregue a página.")}</p>
      ) : tokens.length === 0 ? (
        <EmptyState
          icon={Key}
          headline={t("Nenhuma chave criada ainda.")}
          subcopy={t("Uma chave deixa outro sistema ler ou gravar no CRM sem a sua senha.")}
        />
      ) : (
        <TabelaDeChaves
          tokens={tokens}
          onRevogar={async (id) => {
            await revoke.mutateAsync(id);
            toast.success(t("Chave desligada."));
          }}
          revogando={revoke.isPending}
        />
      )}

      {temporariasTotal > 0 ? (
        <details
          className="rounded-md border p-4"
          onToggle={(e) => setTemporariasAbertas(e.currentTarget.open)}
        >
          <summary className="cursor-pointer text-sm font-medium">
            {t("Chaves temporárias da IA")} ({temporariasTotal})
          </summary>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("Cada atendimento da IA cria uma chave de 5 minutos que se desliga sozinha. Elas ficam guardadas para a auditoria.")}
          </p>
          <div className="mt-3">
            {temporarias.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
            ) : temporarias.isError ? (
              <p className="text-sm text-muted-foreground" role="alert">{t("Não foi possível carregar as chaves. Recarregue a página.")}</p>
            ) : (
              <TabelaDeChaves tokens={temporarias.data?.data ?? []} temporarias />
            )}
          </div>
        </details>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Criar chave")}</DialogTitle>
            <DialogDescription>
              {t("A chave aparece uma vez só, logo depois de criada.")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="t-name">{t("Nome")}</Label>
              <Input
                id="t-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("Ex.: Prontuário")}
                minLength={2}
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>{t("O que a chave pode fazer")}</Label>
              <div className="flex flex-wrap gap-2">
                {SCOPES.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => toggleScope(s.id)}
                    title={t(s.label)}
                    aria-label={`${s.id} — ${t(s.label)}`}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      scopes.includes(s.id) ? "border-primary bg-primary/10" : "border-border"
                    }`}
                  >
                    {t(s.label)}
                    <code className="ml-1 text-muted-foreground">{s.id}</code>
                  </button>
                ))}
              </div>
              {faltaOperador && (
                <p className="text-xs text-warning-fg" role="alert">
                  {t("Remarcar e marcar como realizado só funcionam com a permissão Operador de agenda (role:ai_operator). Marque-a também.")}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-exp">{t("Expira em (dias) — opcional")}</Label>
              <Input
                id="t-exp"
                type="number"
                min={1}
                max={365}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="365"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                {t("Cancelar")}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {t("Criar")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* AlertDialog, sem X nem toque fora: a chave não aparece de novo, então
          só fecha pelo "Já copiei". */}
      <AlertDialog open={!!created}>
        <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Chave criada")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Copie e guarde agora: ela não aparece de novo.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {created ? (
            <div className="space-y-3">
              <code className="block break-all rounded-md border bg-muted p-3 text-sm">
                {created.plaintext}
              </code>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void copyToClipboard(created.plaintext).then((ok) => {
                    if (ok) toast.success(t("Chave copiada."));
                    else toast.error(t("Não foi possível copiar. Selecione a chave acima."));
                  });
                }}
              >
                {t("Copiar chave")}
              </Button>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setCreated(null)}>{t("Já copiei")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A mesma tabela serve às duas listas; nas temporárias o "Revogado" é neutro, porque é o fim normal delas. */
function TabelaDeChaves({
  tokens,
  temporarias = false,
  onRevogar,
  revogando = false,
}: {
  tokens: ApiTokenRow[];
  temporarias?: boolean;
  onRevogar?: (id: string) => Promise<void>;
  revogando?: boolean;
}) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const [revogar, setRevogar] = useState<ApiTokenRow | null>(null);
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Nome")}</TableHead>
            <TableHead>{t("Prefixo")}</TableHead>
            <TableHead>{t("Permissões")}</TableHead>
            <TableHead>{t("Situação")}</TableHead>
            <TableHead>{t("Último uso")}</TableHead>
            <TableHead>{t("Expira")}</TableHead>
            <TableHead className="w-[120px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((tok) => (
            <TableRow key={tok.id}>
              <TableCell className="font-medium">{tok.name}</TableCell>
              <TableCell>
                <code className="text-xs">{tok.prefix}…</code>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {tok.scopes.map((s) => (
                    <Badge key={s} variant="secondary" className="text-xs">
                      {s}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                {tok.revoked_at ? (
                  <Badge variant={temporarias ? "secondary" : "destructive"}>{t("Revogado")}</Badge>
                ) : (
                  <Badge variant="default">{t("Ativo")}</Badge>
                )}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {tok.last_used_at ? new Date(tok.last_used_at).toLocaleString(tagDoIdioma, { dateStyle: "short", timeStyle: "short" }) : t("Nunca")}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {tok.expires_at ? new Date(tok.expires_at).toLocaleDateString(tagDoIdioma) : "—"}
              </TableCell>
              <TableCell>
                {!tok.revoked_at && onRevogar ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revogando}
                    onClick={() => setRevogar(tok)}
                  >
                    {t("Revogar")}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AlertDialog open={revogar !== null} onOpenChange={(aberto) => !aberto && setRevogar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Revogar a chave")} «{revogar?.name}»?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("O sistema que usa esta chave para de funcionar na hora, e isso não tem volta: será preciso criar outra.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={revogando}
              onClick={() => {
                if (revogar && onRevogar) void onRevogar(revogar.id);
              }}
            >
              {t("Revogar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
