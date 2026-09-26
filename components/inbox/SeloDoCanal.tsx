import { InstagramLogo, WhatsappLogo } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Selo redondo de canal (Instagram/WhatsApp), cor de marca do provider + ícone
 * branco. Sozinho não basta distinguir os dois canais na lista (o ícone some a
 * um metro de distância); a cor é a segunda pista, junto do rótulo acessível.
 *
 * `className` existe para o chamador posicionar o selo (absoluto sobre o
 * avatar na lista, inline no cabeçalho) sem duplicar o componente.
 */
export function SeloDoCanal({
  canal,
  tamanho,
  className,
}: {
  canal: "whatsapp" | "instagram";
  tamanho: "pequeno" | "grande";
  className?: string;
}) {
  const rotulo = canal === "instagram" ? "Instagram" : "WhatsApp";
  const Icone = canal === "instagram" ? InstagramLogo : WhatsappLogo;
  const iconSize = tamanho === "pequeno" ? 10 : 13;

  return (
    <span
      role="img"
      aria-label={rotulo}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border-2 border-background text-white",
        canal === "instagram" ? "bg-canal-instagram" : "bg-canal-whatsapp",
        tamanho === "pequeno" ? "h-4 w-4" : "h-5 w-5",
        className,
      )}
    >
      <Icone size={iconSize} weight="fill" aria-hidden />
    </span>
  );
}
