---
impacto: exige_acao
secao: corrigido
titulo: Destinos de IA, webhooks e recursos de processamento protegidos
---

Endpoints de IA escolhidos pelo tenant só aceitam o provedor oficial ou o gateway autorizado pela instalação. O webhook global WAHA exige autenticação também com proxy externo. Atualizações recusam tags fora da main e downloads sem comprovação atual. Estados OAuth inválidos não geram auditoria persistente; assinaturas inválidas não consomem a cota do webhook. O segredo dos crons sai dos argumentos dos processos. PDFs têm limites e rodam em processo separado. Uploads abandonados expiram, com reserva atômica de espaço por organização.

## Requer atenção

Antes de publicar, confira o WAHA externo: a rota global exige HMAC válido ou `Authorization: Bearer <WAHA_HMAC_SECRET>`. O Compose deste pacote envia o header automaticamente ao recriar o WAHA; instalações externas precisam configurar o header no emissor. A exigência explícita de assinatura permanece válida. A rota por token mantém seu contrato.

Gateways próprios de IA precisam corresponder ao `OPENROUTER_BASE_URL` ou `AI_GATEWAY_BASE_URL` autorizado pelo operador. Sem essa autorização, a chamada é recusada. Não alteramos essas variáveis em nenhuma instalação.

Aplique a migração 0300 antes do novo app. Mantenha o scheduler de `storage-redaction` ativo: uploads novos abandonados expiram em 24h e contam na cota até serem removidos. Arquivos anteriores à migração não são apagados automaticamente. PDFs acima de 200 páginas ou 1 milhão de caracteres devem ser divididos.
