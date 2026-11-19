"use client";
import { InterfaceEditor } from "@/components/team/InterfaceEditor";
import {
  INTERFACE_COMPLETA,
  interfaceSettingsSchema,
  interfaceTemDestino,
} from "@/lib/navigation/interface";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { useT } from "@/hooks/i18n/useT";
import { useInviteMembers } from "@/hooks/team/useInviteMembers";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLES, type Role } from "@/lib/schemas/team";
import { ROTULO_DO_PAPEL } from "@/lib/auth/types";
import { descreverMotivoDaFalha } from "./motivo-da-falha";
import { copyToClipboard } from "@/lib/clipboard";
import { Copy } from "@/lib/ui/icons";

// A mesma régua da API (`lib/schemas/team.ts`): um e-mail inválido derrubava a
// lista inteira com um 400 que não dizia qual. Conferimos antes e nomeamos.
const emailValido = z.string().email();

interface ResultState {
  sent: Array<{ email: string; accept_url: string; email_dispatched: boolean; expires_at: string }>;
  failed: Array<{ email: string; reason: string }>;
}

export function InviteForm() {
  const t = useT();
  const [emailsRaw, setEmailsRaw] = useState("");
  const [settings, setSettings] = useState(INTERFACE_COMPLETA);
  const [role, setRole] = useState<Role>("agent");
  const [result, setResult] = useState<ResultState | null>(null);
  const [invalidos, setInvalidos] = useState<string[]>([]);
  const invite = useInviteMembers();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const emails = emailsRaw
      .split(/[\n,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const unique = Array.from(new Set(emails));
    if (unique.length === 0) {
      toast.error(t("Adicione ao menos um email."));
      return;
    }
    if (unique.length > 20) {
      toast.error(t("Máximo 20 emails por convite."));
      return;
    }
    const errados = unique.filter((email) => !emailValido.safeParse(email).success);
    setInvalidos(errados);
    if (errados.length > 0) return;
    try {
      const res = await invite.mutateAsync({
        invitations: unique.map((email) => ({ email, role, interface_settings: settings })),
      });
      setResult(res.data);
      const ok = res.data.sent.length;
      const ko = res.data.failed.length;
      const resumo = `${ok} ${t("convite(s) enviado(s)")}${ko > 0 ? `, ${ko} ${t("falha(s).")}` : "."}`;
      if (ok === 0) toast.error(resumo);
      else if (ko > 0) toast.warning(resumo);
      else toast.success(resumo);
      setEmailsRaw("");
    } catch {
      /* showApiError handled */
    }
  };

  return (
    // Uma coluna: formulário em cima, resultado embaixo (regra de layout).
    <div className="flex max-w-2xl flex-col gap-6">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="emails">{t("E-mails")}</Label>
          <Textarea
            id="emails"
            value={emailsRaw}
            onChange={(e) => {
              setEmailsRaw(e.target.value);
              if (invalidos.length) setInvalidos([]);
            }}
            rows={8}
            placeholder={"alice@empresa.com\nbob@empresa.com"}
            aria-invalid={invalidos.length > 0}
            aria-describedby={invalidos.length > 0 ? "emails-invalidos" : undefined}
          />
          {invalidos.length > 0 ? (
            <p id="emails-invalidos" role="alert" className="text-sm text-destructive">
              {t("Confira estes e-mails:")} <strong>{invalidos.join(", ")}</strong>
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="role">{t("Papel")}</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger id="role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.filter((r) => r !== "viewer").map((r) => (
                <SelectItem key={r} value={r}>
                  {t(ROTULO_DO_PAPEL[r])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {role === "provider" ? (
            <p className="text-xs text-muted-foreground">
              {t("Somente sua agenda e pacientes vinculados.")}
            </p>
          ) : null}
        </div>
        <InterfaceEditor
          value={settings}
          onChange={setSettings}
          role={role}
          disabled={invite.isPending}
        />
        <Button
          type="submit"
          disabled={
            invite.isPending ||
            !interfaceSettingsSchema.safeParse(settings).success ||
            !interfaceTemDestino(settings, role)
          }
        >
          {invite.isPending ? t("Enviando…") : t("Enviar convites")}
        </Button>
      </form>

      <div className="space-y-4">
        {result ? (
          <>
            {result.sent.length > 0 ? (
              <section>
                <h2 className="text-sm font-semibold">
                  {t("Enviados")} ({result.sent.length})
                </h2>
                <ul className="mt-2 space-y-2 text-sm">
                  {result.sent.map((s) => (
                    <li key={s.email} className="rounded-md border p-2">
                      <div className="font-medium">{s.email}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.email_dispatched
                          ? t("Email enviado.")
                          : t("O e-mail não saiu. Copie o link e envie você.")}
                      </div>
                      {!s.email_dispatched ? (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <code className="min-w-0 flex-1 text-xs break-all">{s.accept_url}</code>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            onClick={async () => {
                              if (await copyToClipboard(s.accept_url))
                                toast.success(t("Link do convite copiado."));
                              else toast.error(t("Não foi possível copiar. Copie da barra do navegador."));
                            }}
                          >
                            <Copy size={14} />
                            {t("Copiar link")}
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {result.failed.length > 0 ? (
              <section>
                <h2 className="text-sm font-semibold text-destructive">
                  {t("Falhas")} ({result.failed.length})
                </h2>
                <ul className="mt-2 space-y-1 text-sm">
                  {result.failed.map((f) => (
                    <li key={f.email}>
                      <span className="font-medium">{f.email}</span>{" "}
                      <span className="text-muted-foreground">— {t(descreverMotivoDaFalha(f.reason))}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("Resultados aparecerão aqui após o envio.")}
          </p>
        )}
      </div>
    </div>
  );
}
