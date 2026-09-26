import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SeloDoCanal } from "@/components/inbox/SeloDoCanal";

describe("SeloDoCanal", () => {
  it("Instagram tem rótulo e cor próprios", () => {
    render(<SeloDoCanal canal="instagram" tamanho="pequeno" />);
    const selo = screen.getByLabelText("Instagram");
    expect(selo.className).toContain("bg-canal-instagram");
  });
  it("WhatsApp tem rótulo e cor próprios", () => {
    render(<SeloDoCanal canal="whatsapp" tamanho="pequeno" />);
    expect(screen.getByLabelText("WhatsApp").className).toContain("bg-canal-whatsapp");
  });
});
