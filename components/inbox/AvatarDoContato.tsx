"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** Iniciais do nome ("Geovana Fonseca" → "GF"), com o telefone de reserva. */
export function iniciais(nome: string | null | undefined, reserva: string): string {
  const v = (nome ?? "").trim().replace(/^@/, "");
  const partes = v.split(/\s+/).filter(Boolean);
  if (partes.length === 0) return reserva.slice(0, 2).toUpperCase();
  if (partes.length === 1) return (partes[0] ?? "").slice(0, 2).toUpperCase();
  return `${partes[0]?.[0] ?? ""}${partes[partes.length - 1]?.[0] ?? ""}`.toUpperCase();
}

/**
 * A foto do contato — a MESMA na lista, no topo da conversa e na ficha.
 *
 * Só monta a <img> quando existe arquivo: sem isso o browser pediria a rota
 * para TODO contato e levaria 404 em cada um sem foto, que é a maioria. O
 * `AvatarFallback` do Radix cobre a imagem que não carrega, então as iniciais
 * nunca somem. Contato anonimizado nunca mostra foto.
 */
export function AvatarDoContato({
  contato,
  nome,
  reserva,
  className,
}: {
  contato: { id: string; avatar_storage_path?: string | null; is_anonymized?: boolean | null } | null;
  nome: string | null | undefined;
  reserva: string;
  className?: string;
}) {
  const temFoto = Boolean(contato?.avatar_storage_path) && !contato?.is_anonymized;
  return (
    <Avatar className={cn("h-10 w-10", className)}>
      {temFoto && contato ? (
        <AvatarImage src={`/api/v1/contacts/${contato.id}/avatar`} alt="" className="object-cover" />
      ) : null}
      <AvatarFallback className="bg-accent-soft text-xs font-medium text-accent-hover">
        {iniciais(nome, reserva)}
      </AvatarFallback>
    </Avatar>
  );
}
