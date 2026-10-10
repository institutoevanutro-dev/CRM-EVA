---
impacto: nada_mudou
secao: corrigido
titulo: Next.js e bibliotecas internas sobem para versões com correção de segurança
---
O Next.js sobe de 16.3.4 para 16.3.8, que fecha uma falha grave de requisição forjada pelo servidor no otimizador de imagens e falhas de cache e de vazamento de conteúdo. Sobem também, para as versões corrigidas, as bibliotecas de imagem (`sharp`), de mapa de código (`source-map-js`) e as que atendem a porta MCP do CRM (`@modelcontextprotocol/sdk`, `hono`, `proxy-addr`, `ip-address`), além de `brace-expansion` e `fast-uri`. Com isso a auditoria de dependências de produção fica sem nenhum aviso aberto. Nada muda no uso: a atualização é interna e não pede ação de quem opera o servidor.
