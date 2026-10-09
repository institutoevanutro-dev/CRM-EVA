-- Biblioteca de mídias, fatia 2: a mensagem que levou um item da biblioteca.
-- media_storage_path fica NULO nesses envios de propósito: a anonimização LGPD
-- recolhe só media_storage_path, então nunca enfileira o arquivo do acervo
-- (compartilhado por todas as conversas). Apagar o item preserva o histórico.
alter table public.messages
  add column if not exists media_library_item_id uuid
    references public.media_library_items(id) on delete set null;

create index if not exists messages_media_library_item_idx
  on public.messages (media_library_item_id) where media_library_item_id is not null;

comment on column public.messages.media_library_item_id is
  'Item da biblioteca de mídias enviado nesta mensagem (migration 0327). A variante sai em metadata.media_variant.';
