import { getDatabase } from "../../../../lib/server/db/postgres";
import {
  feedHeaders,
  projectFeedEvent,
  queryFeedEvents,
  type PublicFeedDto,
} from "../../../../lib/server/dal/feed";

export type PublicFeedLoader = () => Promise<readonly PublicFeedDto[]>;

async function loadPublicFeed(): Promise<readonly PublicFeedDto[]> {
  const events = await queryFeedEvents(getDatabase(), { role: "PUBLIC" });
  return events.map((event) =>
    projectFeedEvent({ role: "PUBLIC" }, event),
  );
}

export function createPublicFeedHandler(
  load: PublicFeedLoader = loadPublicFeed,
): () => Promise<Response> {
  return async () => {
    const events = (await load()).map((event) => ({
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      topic: event.topic,
      placeholder: true as const,
    }));
    return Response.json(
      { events },
      { headers: feedHeaders("PUBLIC") },
    );
  };
}

export const GET = createPublicFeedHandler();
