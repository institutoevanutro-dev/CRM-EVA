# Security Cloud: acompanhamento dos 19 achados

Fonte: exportação security-findings.csv, revisão observada ae3128d78. Nenhuma mudança de produção neste pacote.

| ID | Achado | Situação |
|---|---|---|
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_2ffb28d6d7a3e221aa9ed02a | Public webhook routes buffer unbounded request bodies before authentication | Correção neste pacote; validada localmente |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_5a58e25f58c9cadb5c858441 | Tenant members can inject, cancel, delay, or delete service-role worker jobs | PR #83, separado deste pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_5fdaa6fb73e41b8ba2bfdf00 | Platform-admin read APIs ignore enrolled MFA when the policy flag is false | Correção neste pacote; validada localmente |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_735c5bfdca0755691d49d130 | Configured generic webhook HMAC fails open when secret decryption fails | PR #83, separado deste pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_7db31342db2bfec0708eddf3 | Tenant-controlled AI base URLs receive decrypted provider credentials and private-network access | Pendente, não resolvido por este pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_7e20a014052fac9720657074 | Viewer members can rewrite message history and suppress human-escalation alerts | Correção neste pacote; validada localmente |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_9048054e87a6c6255adf0dc0 | Tenant members can control a service-role Storage deletion queue | PR #83, separado deste pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_a7ff324d7711fd7b33905d07 | Updater executes the highest release tag without proving it belongs to protected main | Pendente, não resolvido por este pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_bbabe0a4825dd84d62dbc9ae | Supported proxy topologies expose an unsigned global WAHA webhook | Pendente, não resolvido por este pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_c819328a0932382f5799b14f | Viewer sessions can emit trusted business events and trigger privileged automations | Correção neste pacote; validada localmente |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_5e91a23889f4a74b80b5766c | Agent-level media uploads create unlimited permanent orphan objects | Pendente, não resolvido por este pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_8776ba2f119b30a20835da65 | Invalid OAuth state parameters create unlimited long-lived audit rows | Pendente, não resolvido por este pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_a7d2fb76219877704fd80933 | Viewer members can disable channel pacing and warm-up safeguards | Correção neste pacote; validada localmente |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_e895eca47cca1e67346cf144 | Partner-channel media redirects bypass SSRF validation and expose internal responses | Correção neste pacote; validada localmente |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_e9c968383bf63ef5f858eb88 | RAG PDF extraction has no page, output, time, or memory budget | Pendente, não resolvido por este pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_e9cdbc8c0f9a03b811967d7d | Authenticated upload routes buffer multipart bodies before enforcing size limits | Correção neste pacote; validada localmente |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_b3a7ad2a301171e5116e8cc7 | Unauthenticated requests can consume a lead source's delivery quota | Pendente, não resolvido por este pacote |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_f68497906788e4d06cf01873 | WAHA session backup is created before owner-only permissions are applied | Correção neste pacote; validada localmente |
| rf_wfr_61511db6022143124578a23c15612b80dcd2a80f26ce22a35d4878dc3b09ceec:wfo_31e5eff34e3043aeb372f8b20d3c69e3343371db149aa3e8fb863dac299aa1a9:occ_f6b1e30a567b444b285d5b39 | Shared cron and updater bearer is exposed in recurring process arguments | Pendente, não resolvido por este pacote |

## Limites da validação

Testes usam dados sintéticos. Não houve ataque à produção, inspeção de pacientes, alteração de segredos, merge ou implantação. A baixa dos alertas depende da revisão e de nova análise da versão entregue.

## Evidências locais deste pacote

- 11.117 testes unitários aprovados; um caso de falha esperada.
- 1.896 invariantes de banco aprovados; um caso de falha esperada e um ignorado. Baseline aplicado em instalação e atualização.
- Build de produção, typecheck e verificações de canais, papéis e release aprovados.
- Testes de regressão cobrem recusa de viewer e escrita legítima, MFA, entrada fragmentada, multipart, prazo de leitura, redirecionamento de mídia e máscara do backup antes de criar o arquivo.
