/**
 * Falha ao ler do banco — e NÃO "não há nada aqui".
 *
 * As telas de IA tratavam a consulta que falhou como lista vazia: "Nenhuma
 * chave cadastrada ainda" com o banco fora do ar empurra quem administra a
 * cadastrar a chave de novo. Componente de servidor (sem hooks): o texto chega
 * já traduzido.
 */
export function ErroDeLeitura({ texto }: { texto: string }) {
  return (
    <p
      role="alert"
      data-testid="erro-de-leitura"
      className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted"
    >
      {texto}
    </p>
  );
}
