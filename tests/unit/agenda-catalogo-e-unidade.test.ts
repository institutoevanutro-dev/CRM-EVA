import { describe, expect, it } from "vitest";

import { resolverDuracaoDoTipo } from "@/lib/agenda/consulta";
import { scheduleWindowSchema } from "@/lib/schemas/routing";

const UNIT = "ea720000-0000-4000-8000-000000000001";

describe("agenda ligada ao catálogo e à unidade", () => {
  it("usa a duração do produto quando o tipo está vinculado ao catálogo", () => {
    expect(
      resolverDuracaoDoTipo(
        { catalog_product_id: "produto", duration_minutes: 60 },
        { appointment_duration_minutes: 30 },
      ),
    ).toBe(30);
  });

  it("não oferece automaticamente produto sem duração configurada", () => {
    expect(
      resolverDuracaoDoTipo(
        { catalog_product_id: "produto", duration_minutes: 60 },
        { appointment_duration_minutes: null },
      ),
    ).toBeNull();
  });

  it("mantém a duração própria para tipo sem produto vinculado", () => {
    expect(
      resolverDuracaoDoTipo(
        { catalog_product_id: null, duration_minutes: 60 },
        null,
      ),
    ).toBe(60);
  });

  it("aceita a unidade na janela semanal", () => {
    expect(
      scheduleWindowSchema.parse({ dow: 1, start: "09:00", end: "12:00", unit_id: UNIT }),
    ).toMatchObject({ unit_id: UNIT });
  });
});
