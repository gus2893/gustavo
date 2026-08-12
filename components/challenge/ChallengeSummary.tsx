import type {
  AccountChallengeLedgerItemDto,
  AccountChallengePositionDto,
  AccountChallengeStageDto,
  AccountChallengeStageStatus,
} from "../../lib/server/dal/account-surfaces";

export type ChallengeStageStatus = AccountChallengeStageStatus;

export interface ChallengeStageDto extends Omit<AccountChallengeStageDto, "updatedAt"> {
  readonly updatedAt?: string;
}

export type ChallengePositionDto = AccountChallengePositionDto;

export type ChallengeLedgerItemDto = AccountChallengeLedgerItemDto;

export interface ChallengeSummaryProps {
  readonly stage?: ChallengeStageDto;
  readonly positions?: readonly ChallengePositionDto[];
  readonly ledger?: readonly ChallengeLedgerItemDto[];
  readonly ledgerTruncated?: boolean;
  readonly status?: "ready" | "loading" | "error";
}

const MONEY_PATTERN = /^-?(?:0|[1-9][0-9]*)\.[0-9]{2}$/u;

function money(value: string): string {
  if (!MONEY_PATTERN.test(value)) return "Unavailable";
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction] = unsigned.split(".") as [string, string];
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${negative ? "-" : ""}$${grouped}.${fraction}`;
}

function directionLabel(direction: ChallengePositionDto["direction"]): string {
  return direction === "PAPER_LONG" ? "paper long" : "paper short";
}

export function ChallengeSummary({
  stage,
  positions = [],
  ledger = [],
  ledgerTruncated = false,
  status = "ready",
}: ChallengeSummaryProps) {
  return (
    <main>
      <header>
        <h1>Shared Challenge Portfolio</h1>
        <strong>SIMULATION ONLY — NOT A REAL TRADE</strong>
        <p>Read-only shared Main Brain paper accounting.</p>
      </header>

      {status === "loading" ? (
        <p role="status">Loading Challenge…</p>
      ) : status === "error" ? (
        <p role="alert">Challenge data is unavailable.</p>
      ) : !stage ? (
        <p role="status">No active Challenge stage.</p>
      ) : (
        <section aria-labelledby="challenge-stage-heading">
          <h2 id="challenge-stage-heading">Current stage</h2>
          <p>{stage.status}</p>
          <p>{money(stage.startingBalance)} → {money(stage.targetEquity)}</p>
          <dl>
            <dt>Equity</dt>
            <dd>{money(stage.equity)}</dd>
            <dt>Target</dt>
            <dd>{money(stage.targetEquity)}</dd>
          </dl>
          {stage.updatedAt && (
            <p>Updated <time dateTime={stage.updatedAt}>{stage.updatedAt}</time></p>
          )}
        </section>
      )}

      <section aria-labelledby="paper-positions-heading">
        <h2 id="paper-positions-heading">Paper positions</h2>
        {positions.length === 0 ? (
          <p>No simulated position.</p>
        ) : (
          <ol>
            {positions.map((position) => (
              <li key={position.id}>
                <article>
                  <h3>{position.symbol}: {directionLabel(position.direction)}</h3>
                  <dl>
                    <dt>Quantity</dt><dd>{position.quantity}</dd>
                    <dt>Average paper price</dt><dd>{money(position.averagePrice)}</dd>
                    <dt>Current mark</dt><dd>{money(position.markPrice)}</dd>
                    <dt>Unrealized P&amp;L</dt><dd>{money(position.unrealizedPnl)}</dd>
                    <dt>Simulated costs</dt><dd>{money(position.simulatedCosts)}</dd>
                    <dt>Freshness</dt><dd>{position.freshness}</dd>
                  </dl>
                  <p>Observed <time dateTime={position.observedAt}>{position.observedAt}</time></p>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="challenge-ledger-heading">
        <h2 id="challenge-ledger-heading">Ledger history</h2>
        {ledgerTruncated && <p>Showing the 25 most recent ledger events.</p>}
        {ledger.length === 0 ? (
          <p>No ledger activity yet.</p>
        ) : (
          <ol>
            {ledger.map((item) => (
              <li key={item.id}>
                <span>{item.type}</span>{" "}
                <time dateTime={item.occurredAt}>{item.occurredAt}</time>
                {item.amount !== undefined && <span> Amount: {money(item.amount)}</span>}
                {item.simulatedCosts !== undefined && (
                  <span> Simulated costs: {money(item.simulatedCosts)}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
