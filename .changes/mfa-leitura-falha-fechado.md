---
impacto: nada_mudou
secao: corrigido
titulo: A verificação em duas etapas não é dispensada quando a leitura dos fatores falha
---
Quando o serviço de login não responde no momento de conferir se a conta tem a verificação em duas etapas, a ação agora é recusada em vez de seguir como se a conta não tivesse o fator. Basta tentar de novo quando o serviço voltar.
