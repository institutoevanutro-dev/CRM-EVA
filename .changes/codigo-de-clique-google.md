---
impacto: capacidade_nova
secao: adicionado
titulo: Conversões do Google Ads para quem chegou ao WhatsApp por anúncio do Google
---

Clique em anúncio do Google que abre o WhatsApp não carrega o `gclid` até o CRM, então
nenhum contato nascia marcado como Google e a conexão de conversões do Google nunca tinha o
que enviar. Agora o site pode gravar o id do clique (`gclid`, `gbraid` ou `wbraid`) com um
código curto em `POST /api/v1/publico/clique-google/{token}` e terminar a mensagem
pré-preenchida com "Cód. ABC123". Quando a mensagem chega, o CRM consome o código (uma vez,
até 90 dias) e marca o contato como vindo do Google; o agendamento e o sinal pago desse
contato passam a ser avisados ao Google Ads com o id do clique.

Com id de clique, só ele vai ao Google: telefone e e-mail não saem. O `{token}` é a coluna
`click_capture_token` da conexão do Google Ads. A variável opcional `CLIQUE_GOOGLE_ORIGENS`
libera o CORS para o domínio do site; sem ela a rota grava do mesmo jeito. Quem não usa o
site com código não vê diferença.
