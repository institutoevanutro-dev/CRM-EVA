---
impacto: exige_acao
secao: corrigido
titulo: WhatsApp por QR não perde nem duplica mensagem, e o webhook passa a vir assinado
---
O eco de uma mensagem enviada pelo CRM não pausa mais a IA nem aparece duas vezes. Mensagem que chega com o banco fora do ar é reentregue e reprocessada a cada minuto; se não entrar, a Central avisa. Conversa iniciada pelo celular da clínica vira lead no funil padrão. Resposta citada pelo cliente fica ligada à mensagem original. A rota do webhook sem token só atende a rede interna.

## Requer atenção

Quem atualiza só o app precisa recriar também o WAHA e o scheduler: `docker compose -f docker-compose.prod.yml --env-file .env up -d waha scheduler` (o `update.sh` já faz isso). Só ligue `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true` depois de ver as entregas chegando com `valid_signature = true` em `webhook_events_log`.
