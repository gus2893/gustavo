import { unstable_noStore as noStore } from "next/cache";
import { cookies } from "next/headers";
import { MarketStatus } from "../../../components/market/MarketStatus";
import { sessionCookieName } from "../../../lib/server/auth/sessions";
import {
  loadAccountMarket,
  type AccountMarketDto,
} from "../../../lib/server/dal/account-surfaces";
import { getDatabase } from "../../../lib/server/db/postgres";

export const dynamic = "force-dynamic";

export interface MarketPageDependencies {
  readonly getSession: () => Promise<string | null>;
  readonly loadMarket: (token: string) => Promise<AccountMarketDto>;
}

export async function loadMarketPageData(
  dependencies: MarketPageDependencies,
): Promise<AccountMarketDto> {
  const token = await dependencies.getSession();
  if (token === null) throw new Error("AUTHENTICATION_REQUIRED");
  return dependencies.loadMarket(token);
}

export default async function MarketPage() {
  noStore();
  const environment = process.env.NODE_ENV ?? "development";
  try {
    const data = await loadMarketPageData({
      getSession: async () => (
        (await cookies()).get(sessionCookieName(environment))?.value ?? null
      ),
      loadMarket: (token) => loadAccountMarket(getDatabase(), token),
    });
    return (
      <main>
        <nav aria-label="Account navigation"><a href="/chat">Private chat</a></nav>
        <MarketStatus {...data} />
      </main>
    );
  } catch {
    return (
      <main>
        <MarketStatus items={[]} status="error" />
      </main>
    );
  }
}
