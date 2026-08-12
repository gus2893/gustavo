import { unstable_noStore as noStore } from "next/cache";
import { cookies } from "next/headers";
import { ChallengeSummary } from "../../../components/challenge/ChallengeSummary";
import { sessionCookieName } from "../../../lib/server/auth/sessions";
import { loadAccountChallenge } from "../../../lib/server/dal/account-surfaces";
import { getDatabase } from "../../../lib/server/db/postgres";

export const dynamic = "force-dynamic";

export default async function ChallengePage() {
  noStore();
  const environment = process.env.NODE_ENV ?? "development";
  const token = (await cookies()).get(sessionCookieName(environment))?.value;
  try {
    return <ChallengeSummary {...await loadAccountChallenge(getDatabase(), token ?? "")} />;
  } catch {
    return <ChallengeSummary status="error" />;
  }
}
