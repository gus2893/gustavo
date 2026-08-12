import { unstable_noStore as noStore } from "next/cache";
import { cookies } from "next/headers";
import { Conversation } from "../../../components/chat/Conversation";
import { sessionCookieName } from "../../../lib/server/auth/sessions";
import { loadAccountConversation } from "../../../lib/server/dal/account-surfaces";
import { getDatabase } from "../../../lib/server/db/postgres";

export const dynamic = "force-dynamic";

interface ChatPageProps {
  readonly searchParams?: Promise<{ readonly after?: string | readonly string[] }>;
}

export default async function ChatPage({ searchParams = Promise.resolve({}) }: ChatPageProps) {
  noStore();
  const environment = process.env.NODE_ENV ?? "development";
  const token = (await cookies()).get(sessionCookieName(environment))?.value;
  const rawAfter = (await searchParams).after;
  if (rawAfter !== undefined && typeof rawAfter !== "string") {
    return <Conversation messages={[]} status="error" proposalDisclosure />;
  }
  try {
    const projection = await loadAccountConversation(
      getDatabase(),
      token ?? "",
      rawAfter,
    );
    return <Conversation {...projection} proposalDisclosure />;
  } catch {
    return <Conversation messages={[]} status="error" proposalDisclosure />;
  }
}
