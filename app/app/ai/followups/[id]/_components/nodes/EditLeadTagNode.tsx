"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { useT } from "@/hooks/i18n/useT";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/** Ação sem mensagem no canvas. Portado do projeto original (DeskcommCRM, PR #2181 de @webtecnica). */
export function EditLeadTagNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.edit_lead_tag}
      label={data.label}
      subtitle={describeNodeConfig("edit_lead_tag", data.config, t)}
      selected={selected}
      errors={data.errors}
    />
  );
}
