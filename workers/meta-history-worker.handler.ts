import type { EventHandler } from "@/lib/event-log/dispatcher";
import { META_HISTORY_CONSUMER_KEY, processarChunkDeHistorico } from "@/workers/meta-history-worker";

export const metaHistoryHandler: EventHandler = {
  key: META_HISTORY_CONSUMER_KEY,
  events: ["meta.history_chunk"],
  handle: (row) => processarChunkDeHistorico(row),
};
