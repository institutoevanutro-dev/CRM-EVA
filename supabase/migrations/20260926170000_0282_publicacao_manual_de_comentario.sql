-- Task 8 de 9 da feature "comentários no CRM": a tela humana publica a
-- sugestão da IA (editada ou não) para um comentário `esperando_voce` — e isso
-- é um DESFECHO NOVO, terminal, não um estado transitório (diferente do lease
-- da migration 0281, que a Task 7 escolheu de propósito NÃO virar valor de
-- `situacao`). Nenhum dos cinco valores da 0280 descreve "um humano publicou
-- pela tela": `respondido_pela_ia` é o worker publicando SOZINHO, sem toque
-- humano (Task 7) — reaproveitá-lo aqui apagaria do banco a única distinção
-- que separa as duas Tasks: quem apertou o botão. `POST
-- /api/v1/comentarios/:id/publicar` grava este valor.
alter table public.instagram_comments
  drop constraint if exists instagram_comments_situacao_check;

alter table public.instagram_comments
  add constraint instagram_comments_situacao_check
  check (situacao in (
    'novo',
    'respondido_pela_regra',
    'respondido_pela_ia',
    'esperando_voce',
    'ignorado',
    'respondido_manualmente'
  ));
