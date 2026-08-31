import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getAllianceGuild, getAllianceChannels, createCustomEvent } from "../api/client";
import CustomEventForm, { defaultCustomEventDraft, draftToInput, isDraftValid } from "../components/CustomEventForm";
import { buttonPrimary } from "../components/ui";

export default function AdminCustomEventCreate() {
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillName = searchParams.get("prefillName") ?? "";

  const guildQuery = useQuery({
    queryKey: ["admin-alliance-guild", allianceId],
    queryFn: () => getAllianceGuild(allianceId),
  });
  const guildId = guildQuery.data?.guildId ?? null;

  const channelsQuery = useQuery({
    queryKey: ["admin-alliance-channels", allianceId],
    queryFn: () => getAllianceChannels(allianceId),
  });

  const [draft, setDraft] = useState(() => defaultCustomEventDraft(prefillName));

  const createMutation = useMutation({
    mutationFn: () => {
      const channelName = channelsQuery.data?.find((c) => c.id === draft.channelId)?.name ?? null;
      return createCustomEvent(guildId!, draftToInput(draft, channelName));
    },
    onSuccess: (result) => navigate(`/admin/alliances/${allianceId}/custom-events/${result.id}`),
  });

  return (
    <Layout title="New custom event" backTo={{ to: `/admin/alliances/${allianceId}/custom-events`, label: "Custom events" }}>
      {guildQuery.data && !guildId && <p className="text-sm text-ink-muted">This alliance has no linked Discord server.</p>}

      {guildId && (
        <div className="flex max-w-2xl flex-col gap-4">
          <CustomEventForm draft={draft} onChange={setDraft} channels={channelsQuery.data} />

          <div>
            <button onClick={() => createMutation.mutate()} disabled={!isDraftValid(draft) || createMutation.isPending} className={buttonPrimary}>
              Create event
            </button>
            {createMutation.isError && <p className="mt-1.5 text-sm text-down-ink">{(createMutation.error as Error).message}</p>}
          </div>
        </div>
      )}
    </Layout>
  );
}
