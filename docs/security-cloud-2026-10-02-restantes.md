# Security Cloud: segundo pacote de 2026-10-02

Origem: `security-findings.csv`, CRM-EVA, revisão observada `ae3128d78`. Estes oito achados complementam os oito do PR #84 e os três do PR #83. Correção no código não significa publicação nem encerramento do achado no scanner.

| Ocorrência | Achado | Correção |
|---|---|---|
| `occ_7db31342db2bfec0708eddf3` | Tenant-controlled AI base URLs receive decrypted provider credentials and private-network access | Destinos de IA fixados no provedor ou gateway autorizado pelo operador; redirects recusados nos SDKs afetados. |
| `occ_a7ff324d7711fd7b33905d07` | Updater executes the highest release tag without proving it belongs to protected main | Fetch obrigatório da main, validação de ancestralidade e checkout do SHA verificado. |
| `occ_bbabe0a4825dd84d62dbc9ae` | Supported proxy topologies expose an unsigned global WAHA webhook | Bearer global em tempo constante ou HMAC; recusa sem credencial antes de ler o corpo. Compose envia custom header. |
| `occ_5e91a23889f4a74b80b5766c` | Agent-level media uploads create unlimited permanent orphan objects | Migração 0300: reserva serializada por organização, 20 uploads/100 MiB pendentes, expiração de 24h e limpeza com lease; trigger de mensagens impede corrida com expiração. |
| `occ_8776ba2f119b30a20835da65` | Invalid OAuth state parameters create unlimited long-lived audit rows | Estados OAuth não autenticados recusados sem inserir auditoria persistente. |
| `occ_e9c968383bf63ef5f858eb88` | RAG PDF extraction has no page, output, time, or memory budget | Processo separado, 30s/SIGKILL, 128 MiB de heap V8, 50 MiB de entrada, 200 páginas, 1 milhão de caracteres e dois parsers simultâneos por processo. |
| `occ_b3a7ad2a301171e5116e8cc7` | Unauthenticated requests can consume a lead source's delivery quota | Cota debitada somente depois das verificações de autenticação exigidas pela origem. |
| `occ_f6b1e30a567b444b285d5b39` | Shared cron and updater bearer is exposed in recurring process arguments | Headers por stdin no cron do host e updater; arquivo temporário 0600 no scheduler, sem bearer nos argumentos/crontab. |

## Limites operacionais

- A implantação precisa incluir a migração 0300 e a configuração do emissor WAHA global. A assinatura obrigatória continua obrigatória quando `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true`.
- Endpoints de IA próprios já cadastrados podem ser recusados até que o operador autorize o destino exato pela configuração existente. Não basta ser um host público: o tenant não escolhe onde enviar credenciais da instalação.
- A reserva e o consumo de mídia usam transações/locks no banco. Falha de Storage mantém a cota ocupada e permite retry, em vez de criar espaço para novos órfãos. Arquivos antigos não foram varridos ou apagados.
- O limite de memória do PDF é de heap V8, não de RSS total. Alocações nativas também dependem do limite do contêiner (já declarado no Compose). O processo é descartado ao terminar; não é um sandbox de permissões de SO.
- A migração 0300 é independente das 0298/0299 nos PRs anteriores. A integração deve manter as três e o bloco final de revogação de `anon` no baseline.

## O que não medi

Nenhum ataque, migração, envio, apagamento ou publicação em produção. Nenhum novo scan remoto concluído. A continuidade de um WAHA externo sem o header deve ser verificada antes da implantação. Não houve alteração de variáveis de ambiente ou de compartilhamento do Prontuário.

## Validação local

- Suíte unitária completa: 1.132 arquivos, 11.122 testes aprovados e 1 falha esperada.
- Banco efêmero: 1.896 testes aprovados, 1 falha esperada e 1 skip; instalação e atualização verificadas pelo harness.
- Typecheck e build de produção aprovados; lint sem erros (395 avisos preexistentes).
- Todos os testes de shell, lint de canais, lint de papéis e conferência de release aprovados.
- PDF real extraído pelo worker dentro do standalone gerado. A verificação focada de recursos passou após o ajuste final de remoção idempotente.
