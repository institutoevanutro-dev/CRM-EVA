---
impacto: nada_mudou
secao: corrigido
titulo: Recusas de webhook com teto e IA que não para por endereço antigo
---

Assinaturas inválidas no webhook de captação continuam recusadas, mas só as 30 primeiras por minuto geram registro, para que ninguém inunde a auditoria. Uma `base_url` de IA gravada antes da nova regra não para mais agente, follow-up nem RAG: ela é ignorada, a chamada usa o endpoint oficial e o log avisa. O envio de imagem de cabeçalho de modelo tem limite de 20 por hora por organização. Retornos OAuth inválidos aparecem no log.
