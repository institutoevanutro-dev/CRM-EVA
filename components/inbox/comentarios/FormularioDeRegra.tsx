"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { usePublicacoesDoInstagram } from "@/hooks/comentarios/useComentarios";

export interface NovaRegraDeComentario {
  media_id: string;
  palavra: string;
  texto_do_direct: string;
  frase_publica: string;
  /** Só usado quando a mídia AINDA não tem comentário nenhum — ver `canais` abaixo. */
  channel_session_id?: string;
}

/** Um canal (perfil) de Instagram conectado — o suficiente pro seletor. */
export interface CanalDoInstagram {
  id: string;
  username: string | null;
}

interface Props {
  onCriar: (regra: NovaRegraDeComentario) => void;
  /** Em voo — desabilita o formulário para não duplicar a regra com um duplo clique. */
  enviando?: boolean;
  /** CRÍTICO 2: pré-preenche a mídia quando o formulário abre a partir de "Nova regra para este vídeo". */
  mediaIdInicial?: string;
  /**
   * Perfis de Instagram conectados da organização — só precisa ser escolhido
   * quando a mídia ainda não tem NENHUM comentário (a rota não tem de onde
   * resolver o canal automaticamente nesse caso). Com comentário já existente
   * na mídia, a rota resolve sozinha e este campo é ignorado.
   */
  canais?: CanalDoInstagram[];
}

/**
 * A regra é POR MÍDIA (migration 0279). Quando a mídia JÁ tem comentário, a
 * rota resolve o `channel_session_id` pelo mais recente (Doutrina DIRC —
 * Integrar, não duplicar um seletor) e ignora o que vier aqui. Sem NENHUM
 * comentário ainda (o fluxo que a spec vende: "Comente CARDAPIO neste vídeo"
 * ANTES do primeiro comentário) a rota não tem de onde tirar o canal — por
 * isso o seletor de perfil, usado só nesse caso.
 */
export function FormularioDeRegra({ onCriar, enviando, mediaIdInicial, canais }: Props) {
  const t = useT();
  const [mediaId, setMediaId] = useState(mediaIdInicial ?? "");
  const [palavra, setPalavra] = useState("");
  const [textoDoDirect, setTextoDoDirect] = useState("");
  const [frasePublica, setFrasePublica] = useState("");
  const [channelSessionId, setChannelSessionId] = useState("");
  // A lista de vídeos é do perfil escolhido; sem escolha, do primeiro conectado.
  const canalDaLista = channelSessionId || canais?.[0]?.id || null;
  const publicacoes = usePublicacoesDoInstagram(mediaIdInicial ? null : canalDaLista);

  function escolherPublicacao(id: string) {
    setMediaId(id);
    // O vídeo é deste perfil: a regra nasce nele mesmo sem comentário nenhum.
    if (canalDaLista) setChannelSessionId(canalDaLista);
  }

  const valido =
    mediaId.trim() !== "" &&
    palavra.trim() !== "" &&
    textoDoDirect.trim() !== "" &&
    frasePublica.trim() !== "";

  function submeter(e: React.FormEvent) {
    e.preventDefault();
    if (!valido || enviando) return;
    onCriar({
      media_id: mediaId.trim(),
      palavra: palavra.trim(),
      texto_do_direct: textoDoDirect.trim(),
      frase_publica: frasePublica.trim(),
      ...(canalDaLista ? { channel_session_id: canalDaLista } : {}),
    });
  }

  return (
    <form onSubmit={submeter} className="space-y-3 p-3">
      {canais && canais.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor="regra-canal">{t("Perfil conectado")}</Label>
          <select
            id="regra-canal"
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
            value={canalDaLista ?? ""}
            onChange={(e) => setChannelSessionId(e.target.value)}
            disabled={enviando}
          >
            {canais.map((c) => (
              <option key={c.id} value={c.id}>
                {c.username ? `@${c.username}` : c.id}
              </option>
            ))}
          </select>
        </div>
      )}
      {!mediaIdInicial && canalDaLista && (
        <div className="space-y-1">
          <Label>{t("Escolha o vídeo")}</Label>
          {publicacoes.isLoading ? (
            <p className="text-sm text-text-muted">{t("Carregando vídeos…")}</p>
          ) : publicacoes.isError ? (
            <p className="text-sm text-text-muted">
              {t("Não deu para buscar os vídeos agora. Tente de novo ou cole o id do post.")}
            </p>
          ) : (publicacoes.data ?? []).length === 0 ? (
            <p className="text-sm text-text-muted">{t("Este perfil ainda não tem publicações.")}</p>
          ) : (
            <ul className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto" aria-label={t("Vídeos do perfil")}>
              {(publicacoes.data ?? []).map((p) => {
                const escolhida = p.id === mediaId.trim();
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => escolherPublicacao(p.id)}
                      disabled={enviando}
                      aria-pressed={escolhida}
                      title={p.legenda ?? ""}
                      className={`flex w-full flex-col overflow-hidden rounded-md border text-left text-xs ${
                        escolhida ? "border-primary ring-2 ring-primary" : "border-border"
                      }`}
                    >
                      {p.miniatura ? (
                        // eslint-disable-next-line @next/next/no-img-element -- CDN da Meta, URL que expira; next/image exigiria allowlist fixa.
                        <img src={p.miniatura} alt="" className="aspect-square w-full object-cover" loading="lazy" />
                      ) : (
                        <span className="flex aspect-square w-full items-center justify-center bg-muted text-text-muted">
                          {p.tipo === "VIDEO" ? t("Vídeo") : t("Publicação")}
                        </span>
                      )}
                      <span className="line-clamp-2 p-1 text-text">{p.legenda || t("Sem legenda")}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="regra-media-id">{t("Ou cole o id do post")}</Label>
        <Input
          id="regra-media-id"
          value={mediaId}
          onChange={(e) => setMediaId(e.target.value)}
          placeholder={t("Id do post")}
          disabled={enviando}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="regra-palavra">{t("Palavra-gatilho")}</Label>
        <Input
          id="regra-palavra"
          value={palavra}
          onChange={(e) => setPalavra(e.target.value)}
          placeholder={t("Ex.: CARDAPIO")}
          disabled={enviando}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="regra-direct">{t("Mensagem no Direct")}</Label>
        <Textarea
          id="regra-direct"
          value={textoDoDirect}
          onChange={(e) => setTextoDoDirect(e.target.value)}
          rows={3}
          disabled={enviando}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="regra-publica">{t("Resposta pública")}</Label>
        <Textarea
          id="regra-publica"
          value={frasePublica}
          onChange={(e) => setFrasePublica(e.target.value)}
          rows={2}
          disabled={enviando}
        />
      </div>
      <Button type="submit" disabled={!valido || Boolean(enviando)}>
        {enviando ? t("Salvando…") : t("Criar regra")}
      </Button>
    </form>
  );
}
