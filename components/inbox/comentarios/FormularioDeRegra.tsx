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
}

interface Props {
  onCriar: (regra: NovaRegraDeComentario) => void;
  /** Em voo — desabilita o formulário para não duplicar a regra com um duplo clique. */
  enviando?: boolean;
}

/**
 * A regra é POR MÍDIA (migration 0279) — não pede sessão/canal: a rota
 * resolve o `channel_session_id` pelo comentário mais recente daquela mídia
 * (Doutrina DIRC — Integrar, não duplicar um seletor). Sem nenhum comentário
 * ainda naquela mídia, a rota recusa; o formulário não promete o que a rota
 * não faz.
 */
export function FormularioDeRegra({ onCriar, enviando }: Props) {
  const t = useT();
  const [mediaId, setMediaId] = useState("");
  const [palavra, setPalavra] = useState("");
  const [textoDoDirect, setTextoDoDirect] = useState("");
  const [frasePublica, setFrasePublica] = useState("");

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
      <div className="space-y-1">
        <Label htmlFor="regra-palavra">{t("Palavra-gatilho")}</Label>
        <Input
          id="regra-palavra"
          value={palavra}
          onChange={(e) => setPalavra(e.target.value)}
          placeholder={t("Ex.: preço")}
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
