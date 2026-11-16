import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * MODO PORTARIA: várias instalações no mesmo servidor, atrás de uma portaria (nginx L4) que é a única dona
 * das portas 80/443. O Caddy de cada instalação sobe sem portas, na rede da portaria, e aceita o cabeçalho
 * PROXY (o IP de quem visita) só vindo dela. Quem não usa o modo (REVERSE_PROXY vazio ou caddy) não muda nada:
 * o trecho global só existe dentro do contêiner quando o override o monta.
 */
const ler = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

describe("modo portaria", () => {
  it("o Caddyfile importa os trechos globais do modo DENTRO do bloco global", () => {
    const linhas = ler("Caddyfile").split("\n").map((l) => l.trim());
    const abre = linhas.indexOf("{");
    const fecha = linhas.indexOf("}", abre);
    const imp = linhas.indexOf("import /etc/caddy/global.d/*.caddy");
    expect(abre, "o Caddyfile perdeu o bloco global").toBeGreaterThanOrEqual(0);
    expect(imp, "falta o import dos trechos globais").toBeGreaterThan(abre);
    expect(imp, "o import tem de ficar dentro do bloco global").toBeLessThan(fecha);
  });

  it("o trecho aceita PROXY só na 443, só da subrede da portaria, antes do TLS", () => {
    const t = ler("docker/caddy/portaria-global.caddy");
    expect(t).toMatch(/servers :443 \{/);
    expect(t).toMatch(/proxy_protocol \{[^}]*allow \{\$PORTARIA_SUBNET\}[^}]*\}\s*tls\s*\}/);
  });

  it("o override tira as portas do Caddy, monta o trecho e entra na rede externa da portaria", () => {
    const y = ler("docker-compose.portaria.yml");
    expect(y).toMatch(/\n  caddy:\n    ports: !reset \[\]\n/);
    expect(y).toContain("./docker/caddy/portaria-global.caddy:/etc/caddy/global.d/portaria.caddy:ro");
    expect(y).toContain("PORTARIA_SUBNET: ${PORTARIA_SUBNET:-10.231.231.0/24}");
    expect(y).toMatch(/\n  portaria:\n    external: true\n    name: \$\{PORTARIA_NETWORK_NAME:-evalink-portaria\}\n/);
  });

  it("o compose de produção não monta trecho global nenhum: sem o override, nada muda", () => {
    expect(ler("docker-compose.prod.yml")).not.toContain("global.d");
  });
});
