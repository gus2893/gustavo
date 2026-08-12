import type { PublicFeedDto } from "../../lib/server/dal/feed";

export interface PublicFeedProps {
  readonly events: readonly PublicFeedDto[];
  readonly status?: "ready" | "loading";
}

export default function PublicFeed({
  events,
  status = "ready",
}: PublicFeedProps) {
  const isLoading = status === "loading";

  return (
    <section
      aria-busy={isLoading}
      aria-labelledby="public-activity-heading"
    >
      <header>
        <p>Sample public activity</p>
        <h2 id="public-activity-heading">How a market conversation looks</h2>
        <p>
          Freshness: static sample (not live). Timestamps show the sample
          observation time.
        </p>
      </header>

      {isLoading ? (
        <p role="status">Loading public activity…</p>
      ) : events.length === 0 ? (
        <p role="status">No public activity yet.</p>
      ) : (
        <ol aria-label="Sample public activity">
          {events.map((event) => (
            <li key={event.id}>
              <article aria-label={`Activity placeholder for ${event.topic}`}>
                <header>
                  <p>{event.topic}</p>
                  <time dateTime={event.createdAt}>{event.createdAt}</time>
                </header>
                <div
                  aria-hidden="true"
                  data-testid="feed-placeholder"
                  style={{ display: "grid", gap: "0.5rem" }}
                >
                  {(["100%", "82%", "65%"] as const).map((width) => (
                    <span
                      key={width}
                      style={{
                        background: "currentColor",
                        borderRadius: "999px",
                        display: "block",
                        height: "0.75rem",
                        opacity: 0.14,
                        width,
                      }}
                    />
                  ))}
                </div>
                <p>Protected commentary is available only to authorized accounts.</p>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
