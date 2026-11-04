# Exames do WhatsApp → Prontuário (opcional)

## O que muda

Na conversa do WhatsApp (1:1), a mensagem **recebida nos últimos 60 dias** com PDF, JPG ou PNG de até 10 MB ganha o botão **"Enviar ao prontuário"** embaixo da mídia, para atendente, gerente e administrador. Quem só lê e a sessão de acompanhamento (suporte) não veem o botão: o nome de quem envia vai ao prontuário do paciente.

O servidor do CRM avisa o Prontuário; o Prontuário busca a lista e o arquivo de volta no CRM com uma chave só de leitura e guarda o exame como "Novo, conferir". A mensagem passa a mostrar o selo **"No prontuário"** com quem enviou e quando (ou "já estava lá", quando o exame já tinha sido trazido pelo clínico). O colega com a mesma conversa aberta vê o selo pelo Realtime.

WebP e HEIC mostram a dica "Peça ao paciente um PDF ou foto comum"; arquivo acima de 10 MB e arquivo que não chegou inteiro ao CRM também ganham a sua dica. Toda falha aparece no toast **e** escrita no balão até a próxima tentativa.

Sem configurar, nada muda na tela.

## Contrato

### Rotas que o Prontuário lê (Bearer, escopo exato `prontuario:media:read`)

- `GET /api/v1/prontuario/contacts/{contact_id}/midias?dias=60` (1..180, padrão 60) → `{data: [{message_id, received_at, mime, size_bytes, filename|null, kind}]}`. Só inbound, conversa 1:1 do WhatsApp, contato vivo, mídia já guardada, pdf/jpeg/png/webp/heic, mais recente primeiro, até 200. Contato inexistente, de outra organização, anonimizado ou unido: `{data: []}`. Id malformado: 404. `dias` inválido ou repetido: 422.
- `GET /api/v1/prontuario/midias/{message_id}` → os bytes, `Content-Disposition: attachment` sem nome, `Content-Length`, `Cache-Control: private, no-store`.

| Situação | Resposta |
|---|---|
| inexistente, outra organização, não elegível, WebP/HEIC, caminho fora da mensagem, arquivo ausente no Storage | 404 `not_found`, corpo idêntico |
| mídia ainda não guardada | 409 `midia_ainda_nao_disponivel` |
| acima de 15 MiB | 413 `payload_too_large` |
| limite da chave (60/min por rota) | 429 + `Retry-After: 60` |
| Storage ou banco fora | 503 |

A organização vem da linha do token, nunca da URL. Cada leitura deixa `prontuario.media_listed` (ids, quantidade, dias) ou `prontuario.media_downloaded` (mime, tamanho, contato) na auditoria — nunca nome de arquivo nem conteúdo.

### O envio (`POST /api/v1/messages/{id}/prontuario`, sessão)

O CRM chama `POST {PRONTUARIO_URL}/api/integracoes/crm/exames` com `Authorization: Bearer <PRONTUARIO_EXAMES_SEGREDO>`, `Idempotency-Key: <message_id>` e `{contact_id, message_id, enviado_por}`. 20 s por tentativa, **uma** nova tentativa (mesma chave e corpo) em rede, estouro, 502, 504 e 503 passageiro; nunca nos 503 de configuração. A resposta é lida com teto de 16 KiB. O CRM decide pelo `code`, nunca repassa o texto do Prontuário.

| Prontuário responde | CRM devolve ao navegador |
|---|---|
| 201 / 200 `ja_existia` | 201 / 200 com `{message_id, ja_existia, enviado_em, enviado_por_user_id}` (sem `exam_id`) |
| 404 `paciente_nao_vinculado` | 409 `paciente_nao_vinculado` |
| 409 vínculo não confirmado (`CODIGO_DO_PRONTUARIO_VINCULO_NAO_CONFIRMADO`) | 409 `vinculo_nao_confirmado` |
| 404 `midia_nao_encontrada` | 422 `midia_nao_encontrada` |
| 409 `contato_com_varios_pacientes` / `midia_ainda_nao_disponivel` | 409 com o mesmo código |
| 422 `formato_nao_aceito` / 413 `grande_demais` | 422 com o mesmo código |
| 400, 401, 404 sem código, 413 `pedido_grande_demais`, 503 de configuração | 502 `prontuario_configuracao` ("Avise o administrador") |
| 429 `limite_de_pedidos` | 502 `prontuario_indisponivel` ("recebeu muitos envios") |
| 503 `crm_indisponivel` (depois da nova tentativa) | 502 `prontuario_sem_acesso_ao_crm` |
| outro 5xx, rede, estouro, 2xx inválido | 502 `prontuario_indisponivel` |

O navegador nunca recebe 429/503 do Prontuário: o `apiClient` repetiria o POST. Sucesso grava `prontuario_exames_enviados` e audita `prontuario.exam_sent`; toda outra tentativa audita `prontuario.exam_send_failed` com `codigo`, status e código do Prontuário e número de tentativas (`codigo: sem_resposta` quando não houve resposta; `config_segredo_curto`/`config_url_invalida` quando a configuração daqui é inválida).

As frases de cada código estão em `lib/prontuario/exames.ts` (`FRASE_DO_CODIGO`), com espanhol.

## Configuração

Três variáveis opcionais no `.env` do CRM (chegam pelo `env_file`; nada no compose):

- `PRONTUARIO_URL`: origem **https** do Prontuário, sem caminho (ex.: `https://prontuario.exemplo.com.br`).
- `PRONTUARIO_EXAMES_SEGREDO`: o mesmo segredo do Prontuário, 32+ caracteres (`openssl rand -hex 32`).
- `PRONTUARIO_ORGANIZATION_ID`: UUID da organização da clínica; as outras organizações da instalação não veem o botão.

Três estados (`estadoDosExames`): **desligada** (as três vazias ou outra organização: nada na tela), **inválida** (organização certa com segredo curto ou URL que não é origem https: o botão aparece e o clique diz "avise o administrador", com `logger.error` e linha de falha na auditoria) e **ligada**.

E uma chave nova no CRM, criada na organização da clínica em Configurações › Chaves de integração, só com o escopo "Prontuário: baixar PDF e fotos que o paciente mandou pelo WhatsApp" (`prontuario:media:read`). Ela vai ao Prontuário como `CRM_EXAMES_TOKEN`; o escopo só abre as duas rotas acima (`tests/unit/escopo-prontuario-midia-nao-abre-outra-porta.test.ts`).

## Ativação e verificação

**Pré-requisito antes de ligar:** o Prontuário registra no CRM (`POST /api/v1/prontuario/contacts/link`) os vínculos criados pela agenda, com um backfill dos existentes. Sem isso, juntar duas fichas que são dois pacientes pode mandar o exame de um ao prontuário do outro — pelo botão e pelo "Trazer do WhatsApp".

Segredo e chave nunca no chat; colar com `read -rs` e limpar a área de transferência (`pbcopy < /dev/null`) depois de cada colagem.

1. Gerar o segredo no computador do administrador e gravá-lo como `PRONTUARIO_EXAMES_SEGREDO` no `.env` do Prontuário.
2. Criar a chave `prontuario:media:read` no CRM (aparece uma vez) e gravá-la como `CRM_EXAMES_TOKEN` no Prontuário; reiniciar o Prontuário.
3. Sonda sem segredo: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://prontuario.exemplo.com.br/api/integracoes/crm/exames` tem de dar **401**, não 503.
4. No `.env` do CRM, acrescentar as três variáveis (`grep -c '^PRONTUARIO_' .env` tem de dar 3) e recriar só o `app` pelo procedimento de deploy (`docs/runbooks/deploy.md`); conferir 307 no domínio.
5. Recarregar o Inbox; numa conversa de paciente vinculado com PDF recente, enviar e ver o selo; no Prontuário, o exame "Novo, conferir"; em `/app/audit`, `prontuario.exam_sent`, `prontuario.media_listed` e `prontuario.media_downloaded`.

**Se o botão não aparecer:** `grep -c '^PRONTUARIO_' .env` = 3; o UUID de `PRONTUARIO_ORGANIZATION_ID` é o da organização aberta na tela; o contêiner foi recriado depois da edição. Se aparecer e o clique disser "avise o administrador", filtrar `prontuario.exam_send_failed` em `/app/audit`: o `codigo` diz o quê.

## Desligar

Esvaziar as três variáveis no `.env` do CRM e recriar o `app`. Revogar a chave na tela desliga também o "Trazer do WhatsApp" do Prontuário. Com só `PRONTUARIO_ORGANIZATION_ID` preenchida o estado é "inválida", não "desligada".

## Fronteira LGPD

- O registro do envio (`prontuario_exames_enviados`, migration 0402) é só da service role. O `exam_id` aponta para o paciente no Prontuário e fica só no banco: não vai ao navegador nem à auditoria.
- Anonimizar o contato apaga o registro (gatilho da 0402); a mensagem é redigida pela regra existente e as rotas param de servir. Na fusão de fichas o registro continua (é por mensagem).
- A exportação ao titular lista os arquivos enviados ao prontuário (id da mensagem, data, "já estava"), sem `exam_id`.
- O exame já gravado no Prontuário **não** é alcançado pela cascata do CRM; vale o mesmo para o "Trazer do WhatsApp" do clínico.

## Living System Checklist

- **Quem me alimenta:** mensagem inbound com `media_storage_path` gravado por `workers/media-persist-worker.ts`; o clique em `components/inbox/ExameNoProntuario.tsx`.
- **Quem eu alimento:** o Prontuário (exame "Novo, conferir"); o selo (`prontuario_exames_enviados` → lista de mensagens → balão, e Realtime para o colega).
- **Atividade/log:** `api_audit_log` com `prontuario.exam_sent`, `prontuario.exam_send_failed`, `prontuario.media_listed`, `prontuario.media_downloaded`; logger `prontuario.exames.*` com `request_id` e `message_id`.
- **Onde apareço:** balão (botão, selo, dica, erro); `/app/audit`; Chaves de integração. Nenhuma tela nova.
- **Anti-morte:** idempotente por `message_id`; o botão volta com o motivo escrito; registro só no sucesso. Dívida: mídia que nunca persiste nunca ganha botão (a que o worker marcou como falha ganha a dica).
- **Configuração:** `.env` e a tela de chaves. Pela metade, não some calada. Dívida declarada: não há tela para ver a configuração, e `PRONTUARIO_ORGANIZATION_ID` com outro UUID não aparece para ninguém (diagnóstico acima).
- **Laço de retorno:** toda tentativa sem sucesso vira `prontuario.exam_send_failed` com `codigo`. `paciente_nao_vinculado` alto mede a falta de vínculo; `formato_nao_aceito` em pdf/jpeg/png decide se vale farejar bytes no CRM; `prontuario_configuracao` repetido decide um aviso na Central.
- **Mapa vivo:** `docs/architecture/exames-do-whatsapp.architecture.json`.

Prova: `tests/invariants/exames-do-whatsapp-no-prontuario.test.ts` (banco, duas organizações), os testes das três rotas, `lib/integrations/prontuario/cliente.test.ts` e `tests/e2e/inbox-enviar-exame-ao-prontuario.spec.ts` (tela, com Prontuário falso).
