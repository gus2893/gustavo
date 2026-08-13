import PublicFeed from "../components/feed/PublicFeed";
import type { PublicFeedDto } from "../lib/server/dal/feed";

const publicActivity: readonly PublicFeedDto[] = [
  {
    id: "public-activity-1",
    type: "market.commentary.updated",
    createdAt: "2026-08-12T14:30:00.000Z",
    topic: "Market structure",
    placeholder: true,
  },
  {
    id: "public-activity-2",
    type: "brain.council.completed",
    createdAt: "2026-08-12T14:15:00.000Z",
    topic: "Council activity",
    placeholder: true,
  },
] as const;

export default async function PublicHome() {
  return (
    <main>
      <header>
        <p>
          <a href="https://gustavo.lol">https://gustavo.lol</a>
        </p>
        <h1>Gustavo</h1>
        <p>The market thinks out loud.</p>
        <p>
          Educational market commentary about current prices, uncertainty, and
          competing interpretations—not individualized financial advice.
        </p>
        <p>SIMULATION ONLY — NOT A REAL TRADE</p>
      </header>

      <PublicFeed events={publicActivity} />

      <aside aria-labelledby="memory-disclosure-heading">
        <h2 id="memory-disclosure-heading">How memory works</h2>
        <p>
          Gustavo uses permission-scoped software memory. It is not sentient,
          does not reveal hidden chain-of-thought, and does not perfectly recall
          unstored or unauthorized conversations.
        </p>
      </aside>
    </main>
  );
}
