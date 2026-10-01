"use client";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { marcarReleitura } from "@/lib/audit/releitura";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { TimelineItemView } from "@/lib/types/contacts";

interface TimelineResponse {
  data: TimelineItemView[];
  meta?: { cursor?: string; has_more?: boolean };
}

export function useTimeline(contactId: string, types?: string[]) {
  const qc = useQueryClient();
  const queryKey = ["timeline", contactId, types ?? null] as const;
  return useInfiniteQuery({
    queryKey,
    enabled: !!contactId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", "30");
      marcarReleitura(qs, qc.getQueryData(queryKey) !== undefined);
      if (types && types.length > 0) {
        for (const t of types) qs.append("type", t);
      }
      try {
        return await apiClient.get<TimelineResponse>(
          `/api/v1/contacts/${contactId}/timeline?${qs.toString()}`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (lastPage) =>
      lastPage.meta?.has_more ? lastPage.meta.cursor : undefined,
  });
}
