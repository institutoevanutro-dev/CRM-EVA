---
impacto: nada_mudou
secao: corrigido
titulo: O worker procura acontecimento travado no máximo uma vez por minuto
---

O worker procurava acontecimento travado no meio do processamento (parado há mais de 10 minutos) em toda passada, numa consulta que não tinha como achar nada novo. Agora ele procura assim que sobe e depois no máximo uma vez por minuto. O ritmo com que ele pega acontecimentos novos não muda: o espaçamento das passadas sem movimento, que o original também trouxe, ficou de fora para não atrasar a primeira resposta depois de um silêncio. O cron de 1 minuto (`event-log-drain`, no serviço `scheduler`) continua fazendo a mesma procura. Ajuste opcional, com padrão, que não precisa ir para o `.env`: `EVENT_LOG_DRAIN_STALE_SWEEP_MS` (60000).

Portado do projeto original (DeskcommCRM, PR #3701 de @webtecnica, a partir da medição de @DPalmercs na issue #3693; só a parte da procura por travados).
