import { NextResponse } from "next/server";

/**
 * A página que a pessoa vê depois de enviar o formulário do site, quando a
 * fonte não tem "página de agradecimento" configurada.
 *
 * Sem ela, o navegador mostrava o JSON da API (`{"data":{"lead_id":…}}`) —
 * uma página só com código para o paciente. Sem marca e sem cor de propósito:
 * não há sessão nem organização resolvida aqui, e a página precisa funcionar
 * em qualquer instalação. Texto fixo, sem nada vindo do envio (nada a escapar).
 */
const HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recebemos seus dados</title>
</head>
<body style="font-family: system-ui, -apple-system, sans-serif; max-width: 32rem; margin: 15vh auto; padding: 0 16px; text-align: center; line-height: 1.5;">
<h1 style="font-size: 1.5rem;">Recebemos seus dados. Obrigado!</h1>
<p>Em breve entraremos em contato.</p>
</body>
</html>`;

export function paginaDeObrigado(requestId: string): NextResponse {
  return new NextResponse(HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "x-request-id": requestId },
  });
}
