"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

/**
 * O ícone da aba da instalação (migration 0291). Sobe e remove por
 * `/api/v1/marca/icone`; a prévia mostra o arquivo enviado do jeito que a aba
 * mostra — pequeno, sobre o cinza da barra do navegador. Sem arquivo, a aba
 * segue com o ícone desenhado pelo sistema.
 *
 * A prévia guarda a URL que a própria resposta devolveu, em vez de esperar o
 * `router.refresh()`: é o mesmo cuidado de `CampoDeLogo` (o refresh não é
 * confiável para reexibir o resultado da própria ação).
 */
export function CampoDeIcone({ iconeUrl }: { iconeUrl: string | null }) {
  const t = useT();
  const router = useRouter();
  const entrada = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(iconeUrl);
  const [enviando, setEnviando] = useState(false);

  async function falha(resposta: Response): Promise<string> {
    const corpo = (await resposta.json().catch(() => null)) as { error?: { message?: string } } | null;
    return corpo?.error?.message ?? t("Não consegui trocar o ícone agora.");
  }

  async function enviar(arquivo: File) {
    setEnviando(true);
    try {
      const corpo = new FormData();
      corpo.set("file", arquivo);
      const resposta = await fetch("/api/v1/marca/icone", { method: "POST", body: corpo });
      if (!resposta.ok) return void toast.error(await falha(resposta));
      const { data } = (await resposta.json()) as { data: { icone_url: string | null } };
      setUrl(data.icone_url);
      toast.success(t("Ícone atualizado. A aba troca em até um minuto."));
      router.refresh();
    } finally {
      setEnviando(false);
      if (entrada.current) entrada.current.value = "";
    }
  }

  async function remover() {
    setEnviando(true);
    try {
      const resposta = await fetch("/api/v1/marca/icone", { method: "DELETE" });
      if (!resposta.ok) return void toast.error(await falha(resposta));
      setUrl(null);
      toast.success(t("Ícone removido. A aba volta ao ícone desenhado pelo sistema."));
      router.refresh();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-base font-semibold">{t("Ícone da aba")}</h2>
        <p className="mt-1 text-sm text-text-muted">
          {t("A imagem pequena que aparece na aba do navegador e nos favoritos. PNG quadrado, de preferência 512×512.")}
        </p>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-border bg-muted">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={t("Ícone da aba atual")} width={32} height={32} className="h-8 w-8 rounded-md" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/icon" alt={t("Ícone desenhado pelo sistema")} width={32} height={32} className="h-8 w-8 rounded-md" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={entrada}
            type="file"
            accept="image/png"
            className="sr-only"
            id="icone-da-aba"
            onChange={(e) => {
              const arquivo = e.target.files?.[0];
              if (arquivo) void enviar(arquivo);
            }}
          />
          <Button type="button" variant="outline" disabled={enviando} onClick={() => entrada.current?.click()}>
            {enviando ? t("Enviando…") : url ? t("Trocar ícone") : t("Enviar ícone")}
          </Button>
          {url && (
            <Button type="button" variant="ghost" disabled={enviando} onClick={() => void remover()}>
              {t("Remover")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
