-- ============================================================================
-- 0371 — A COR DO FUNIL: cada funil pode ter um tom próprio
--
-- ─── O problema
--
-- A clínica trabalha com vários funis (atendimento, pacientes, pós-venda) e a
-- lista de Funis, o seletor rápido no título do quadro e o cabeçalho do quadro
-- os mostravam todos iguais. A ETAPA já tinha cor (`crm_stages.color`); o funil,
-- não.
--
-- ─── A regra
--
-- `crm_pipelines.color`, com a MESMA forma do CHECK de `crm_stages.color`
-- (`^#[0-9a-fA-F]{6}$`, NULL = sem cor). Coluna, e não `settings.color`: o
-- `settings` do funil guarda os campos personalizados e os motivos de perda, e
-- gravar a cor ali exigiria ler-mesclar-gravar o jsonb (duas abas abertas se
-- apagariam). Coluna com CHECK é uma escrita simples, que a rota de funis já
-- faz (`PATCH /api/v1/pipelines/[id]`, manager+, auditada como
-- `pipeline.updated`).
--
-- A pertinência à paleta NÃO é cobrada no banco, como na etapa e na etiqueta: a
-- paleta é decoração de tela (`lib/pipelines/cor-do-funil.ts`), e quem quiser
-- outro tom grava pela API.
--
-- Funil sem cor fica exatamente como era. Nenhum dado é tocado.
-- Idempotente: `add column if not exists` com o CHECK no mesmo comando.
-- Vigiado por tests/invariants/cor-do-funil.test.ts.
-- ============================================================================

alter table public.crm_pipelines
  add column if not exists color text
  constraint crm_pipelines_color_format check (color is null or color ~ '^#[0-9a-fA-F]{6}$');

comment on column public.crm_pipelines.color is
  'Cor do funil (migration 0371): #rrggbb ou NULL (sem cor). Mesma forma de crm_stages.color. Mostrada na lista de Funis, no seletor do título do quadro e no cabeçalho do quadro.';

notify pgrst, 'reload schema';
