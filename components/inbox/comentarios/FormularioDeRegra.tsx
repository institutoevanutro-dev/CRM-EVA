"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

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
      ...(channelSessionId ? { channel_session_id: channelSessionId } : {}),
    });
  }

  return (
    <form onSubmit={submeter} className="space-y-3 p-3">
      <div className="space-y-1">
        <Label htmlFor="regra-media-id">{t("Mídia (id do post)")}</Label>
        <Input
          id="regra-media-id"
          value={mediaId}
          onChange={(e) => setMediaId(e.target.value)}
          placeholder={t("Cole o id do post")}
          disabled={enviando}
        />
      </div>
      {canais && canais.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor="regra-canal">{t("Perfil conectado (só se o vídeo ainda não tem comentário nenhum)")}</Label>
          <select
            id="regra-canal"
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
            value={channelSessionId}
            onChange={(e) => setChannelSessionId(e.target.value)}
            disabled={enviando}
          >
            <option value="">{t("Resolver automaticamente pelo comentário mais recente")}</option>
            {canais.map((c) => (
              <option key={c.id} value={c.id}>
                {c.username ? `@${c.username}` : c.id}
              </option>
            ))}
          </select>
        </div>
      )}
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
