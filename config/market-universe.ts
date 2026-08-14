export type MarketUniverseKind = "STOCK" | "ETF";

export interface MarketUniverseItem {
  readonly symbol: string;
  readonly kind: MarketUniverseKind;
}

const STOCK_SYMBOLS = Object.freeze([
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "BRK.B", "AVGO",
  "JPM", "LLY", "V", "XOM", "MA", "UNH", "COST", "WMT", "NFLX", "ORCL", "HD", "PG",
  "JNJ", "BAC", "ABBV", "KO", "CRM", "CVX", "MRK", "AMD", "PLTR", "CSCO", "ACN", "MCD",
  "IBM", "GE", "CAT", "GS", "MS", "AXP", "BX", "TMO", "ISRG", "LIN", "ABT", "DIS", "NOW",
  "QCOM", "TXN", "AMGN", "DHR", "PEP", "PM", "INTU", "BKNG", "RTX", "AMAT", "SPGI", "NEE",
  "LOW", "UPS", "HON", "PFE", "C", "MU", "SBUX", "COP", "SCHW", "GILD", "ADP", "DE", "BLK",
  "PANW", "LRCX", "KLAC",
] as const);

const ETF_SYMBOLS = Object.freeze([
  "SPY", "QQQ", "DIA", "IWM", "VTI", "VO", "VB", "VOO", "IVV", "XLK", "XLF", "XLE", "XLV",
  "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "ARKK",
] as const);

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9]*(?:\.[A-Z])?$/;

function freezeCatalogItems<const Symbols extends readonly string[], const Kind extends MarketUniverseKind>(
  symbols: Symbols,
  kind: Kind,
): readonly Readonly<{ readonly symbol: Symbols[number]; readonly kind: Kind }>[] {
  return Object.freeze(symbols.map((symbol) => Object.freeze({ symbol, kind })));
}

const stockItems = freezeCatalogItems(STOCK_SYMBOLS, "STOCK");
const etfItems = freezeCatalogItems(ETF_SYMBOLS, "ETF");

if (stockItems.length !== 75 || etfItems.length !== 20) {
  throw new Error("MARKET_UNIVERSE_INVALID");
}

const marketUniverse = [...stockItems, ...etfItems];
const uniqueSymbols = new Set<string>();
for (const item of marketUniverse) {
  if (item.symbol !== item.symbol.trim()
    || !SYMBOL_PATTERN.test(item.symbol)
    || uniqueSymbols.has(item.symbol)
    || (item.kind !== "STOCK" && item.kind !== "ETF")) {
    throw new Error("MARKET_UNIVERSE_INVALID");
  }
  uniqueSymbols.add(item.symbol);
}
if (marketUniverse.length !== 95 || uniqueSymbols.size !== 95) {
  throw new Error("MARKET_UNIVERSE_INVALID");
}

export const MARKET_UNIVERSE = Object.freeze(marketUniverse);
export type MarketUniverseSymbol = typeof MARKET_UNIVERSE[number]["symbol"];
