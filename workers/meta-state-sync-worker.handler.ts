import type { EventHandler } from "@/lib/event-log/dispatcher";
import { META_STATE_SYNC_CONSUMER_KEY, processarStateSync } from "@/workers/meta-state-sync-worker";

export const metaStateSyncHandler: EventHandler = {
  key: META_STATE_SYNC_CONSUMER_KEY,
  events: ["meta.state_sync"],
  handle: (row) => processarStateSync(row),
};
