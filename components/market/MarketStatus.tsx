import type { AccountMarketItemDto } from "../../lib/server/dal/account-surfaces";

export interface MarketStatusProps {
  readonly items: readonly AccountMarketItemDto[];
  readonly status?: "ready" | "error";
}

function safeLabel(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

export function MarketStatus({ items, status = "ready" }: MarketStatusProps) {
  return (
    <section aria-labelledby="market-status-heading">
      <header>
        <h1 id="market-status-heading">Private market dashboard</h1>
        <p>Personal-use observations for the fixed 95-symbol universe.</p>
      </header>
      {status === "error" ? (
        <p role="alert">Private market observations are unavailable.</p>
      ) : items.length === 0 ? (
        <p role="status">No private market observations are available.</p>
      ) : (
        <ol aria-label="Private market statuses">
          {items.map((item) => {
            const successfulPrice = item.status === "SUCCESS" && item.price !== null;
            return (
              <li key={item.symbol} data-market-symbol={item.symbol}>
                <article>
                  <header>
                    <h2>{item.symbol}</h2>
                    <p>{item.kind}</p>
                  </header>
                  <dl>
                    <dt>Status</dt>
                    <dd>{item.freshness}</dd>
                    <dt>Price</dt>
                    <dd>{successfulPrice ? `$${item.price}` : "Unavailable"}</dd>
                    <dt>Provider observation</dt>
                    <dd>
                      {item.sourceObservedAt === null ? "Unavailable" : (
                        <time dateTime={item.sourceObservedAt}>{item.sourceObservedAt}</time>
                      )}
                    </dd>
                    <dt>Received</dt>
                    <dd>
                      {item.receivedAt === null ? "Unavailable" : (
                        <time dateTime={item.receivedAt}>{item.receivedAt}</time>
                      )}
                    </dd>
                    <dt>Age</dt>
                    <dd>{item.ageSeconds === null ? "Unavailable" : `${item.ageSeconds} seconds`}</dd>
                  </dl>
                  {item.safeCode === null ? null : (
                    <p>{safeLabel(item.safeCode)}</p>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
