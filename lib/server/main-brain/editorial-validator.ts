export const BROADCAST_POLICY_ERROR = "BROADCAST_POLICY_REJECTED";

interface PolicyClause {
  /** Lower-cased normalized tokens for grammatical and ticker-object checks. */
  readonly words: string;
  readonly compact: string;
}

interface PolicyText {
  /** Whole boundary-preserved text used for confusable token extraction. */
  readonly deobfuscated: string;
  /** Independent bounded clauses used for all grammatical policy checks. */
  readonly clauses: readonly PolicyClause[];
}

const DIRECT_ACTION_PATTERNS = [
  /\b(?:you|we|investors|traders|users)\s+(?:really\s+)?(?:should|must|need\s+to|have\s+to|ought\s+to)\s+(?:be\s+)?(?:buy(?:ing)?|sell(?:ing)?|hold(?:ing)?|short(?:ing)?|trad(?:e|ing)|enter(?:ing)?|exit(?:ing)?|purchas(?:e|ing)|acquir(?:e|ing)|dispos(?:e|ing)|open(?:ing)?|clos(?:e|ing)|go\s+long|go\s+short)\b/,
  /\b[a-z0-9]{1,16}\s+(?:should|must|needs?\s+to)\s+(?:be\s+)?(?:bought|sold|held|purchased|acquired|disposed|exited|entered|opened|closed)\b/,
  /\bi\s+(?:recommend|advise)\s+(?:that\s+)?(?:you\s+)?(?:to\s+)?(?:buy(?:ing)?|sell(?:ing)?|hold(?:ing)?|short(?:ing)?|trad(?:e|ing)|enter(?:ing)?|exit(?:ing)?|purchas(?:e|ing)|acquir(?:e|ing)|dispos(?:e|ing)|open(?:ing)?|clos(?:e|ing)|go\s+long|go\s+short)\b/,
  /\b(?:buy|sell|hold|purchase|acquire|dispose|enter|exit|open|close)\s+(?:now|today|immediately)\b/,
  /\b(?:go|stay)\s+(?:long|short)\b/,
  /\b(?:enter|exit)\s+(?:the\s+)?(?:trade|position|market)\b/,
  /\b(?:instruction|recommendation|signal|action)(?:\s+(?:is|says|to))?\s+(?:to\s+)?(?:buy(?:ing)?|sell(?:ing)?|hold(?:ing)?|short(?:ing)?|trad(?:e|ing)|enter(?:ing)?|exit(?:ing)?|purchas(?:e|ing)|acquir(?:e|ing)|dispos(?:e|ing)|open(?:ing)?|clos(?:e|ing)|go\s+long|go\s+short)\b/,
  /\b(?:consider|try)\s+(?:buying|selling|holding|shorting|trading|entering|exiting|purchasing|acquiring|disposing|opening|closing)\b/,
  /\b(?:(?:my|our|the)\s+)?(?:recommendation|advice)\s+is\s+(?:to\s+)?(?:buy(?:ing)?|sell(?:ing)?|hold(?:ing)?|short(?:ing)?|trad(?:e|ing)|enter(?:ing)?|exit(?:ing)?|purchas(?:e|ing)|acquir(?:e|ing)|dispos(?:e|ing)|open(?:ing)?|clos(?:e|ing))\b/,
  /^(?:buying|selling|holding|shorting|trading|entering|exiting|purchasing|acquiring|disposing|opening|closing)\b.{0,80}\b(?:now|today|immediately)\b/,
  /\b(?:buying|selling|holding|shorting|trading|entering|exiting|purchasing|acquiring|disposing|opening|closing)\b(?:\s+[a-z0-9]+){0,8}\s+(?:is|looks)\s+(?:advisable|recommended)\b/,
] as const;

const EXECUTION_PATTERNS = [
  /\b(?:place|submit|execute|send|route)\s+(?:(?:a|an|the|this|your)\s+)?(?:(?:market|limit|stop)\s+)?(?:order|trade)\b/,
  /\b(?:open|close)\s+(?:(?:a|the|this|your)\s+)?(?:live\s+)?position\b/,
  /\b(?:set|move)\s+(?:(?:a|the|your)\s+)?(?:stop|stoploss|takeprofit)\b/,
] as const;

const REAL_TRADE_PATTERNS = [
  /\b(?:this\s+is\s+)?not\s+(?:a\s+)?simulation\b/,
  /\b(?:real|live)\s+(?:money\s+)?trade\b/,
  /\breal\s+money\b/,
  /\breal\s+account\b/,
  /\bcopy\s+(?:this\s+)?trade\b/,
  /\bfollow\s+(?:this\s+)?signal\b/,
  /\bact\s+on\s+(?:this|it)\b/,
  /\btrade\s+this\s+in\s+your\s+account\b/,
] as const;

const SENSITIVE_EXECUTION_PATTERNS = [
  /\b(?:credentials?|passwords?|passcodes?|account\s+numbers?|private\s+keys?|api\s+keys?)\b/,
  /\b(?:broker|brokers|brokerage)\b/,
  /\b(?:market|limit|stop)\s*order\b/,
  /\border\s+(?:entry|ticket|routing)\b/,
  /\b(?:through|with|on)\s+your\s+(?:broker|brokerage)\b/,
  /\byour\s+(?:broker|brokerage)\s+(?:account|login|portal)\b/,
] as const;

const PERSONAL_CONTEXT_PATTERN = /\b(?:for|in|based\s+on)\s+your\s+(?:account|portfolio|finances|financial\s+situation|risk\s+tolerance|circumstances)\b/;
const ACTION_WORD_PATTERN = /\b(?:buy|buying|sell|selling|hold|holding|short|shorting|trade|trading|enter|entering|exit|exiting|purchase|purchasing|acquire|acquiring|dispose|disposing|open|opening|close|closing|position|order|go\s+long|go\s+short)\b/;
const IMPOSSIBLE_RISK_PATTERNS = [
  /\b(?:norisk|zerorisk|riskfree)\b/,
  /\b(?:no|zero)\s+risk\b/,
  /\brisk\s+free\b/,
  /\b(?:cannot|cant|wont|willnot)\s+lose\b/,
  /\b(?:cannot|cant|wont|willnot)\s+fail\b/,
  /\bno\s+downside\b/,
  /\b(?:will|must)\s+(?:definitely\s+)?(?:profit|win|rise|rally|fall|drop)\b/,
] as const;

const PROTECTED_CONFUSABLE_LEXEMES = new Set([
  "buy",
  "sell",
  "hold",
  "short",
  "long",
  "trade",
  "enter",
  "exit",
  "broker",
  "brokerage",
  "order",
  "credential",
  "credentials",
  "guarantee",
  "guaranteed",
  "riskfree",
  "purchase",
  "acquire",
  "dispose",
  "open",
  "close",
]);

// This deliberately small map covers confusables in protected policy lexemes.
// Unrelated non-Latin text remains valid; only an exact protected skeleton fails.
const CONFUSABLE_TO_LATIN: Readonly<Record<string, string>> = Object.freeze({
  "\u03b1": "a",
  "\u03b2": "b",
  "\u03b5": "e",
  "\u03b9": "i",
  "\u03ba": "k",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u0430": "a",
  "\u0432": "b",
  "\u0441": "c",
  "\u0435": "e",
  "\u0456": "i",
  "\u043a": "k",
  "\u043c": "m",
  "\u043e": "o",
  "\u0440": "p",
  "\u0442": "t",
  "\u0443": "u",
  "\u0445": "x",
  "\u0455": "s",
  "\u04cf": "l",
});

const OUTCOME_TERMS = new Set([
  "profit", "profits", "return", "returns", "gain", "gains", "outcome",
  "outcomes", "win", "wins", "success", "upside", "downside", "move",
  "direction", "rise", "rally", "fall", "drop", "breakout", "breakdown",
  "target", "result", "results", "trade",
]);
const CERTAINTY_PREDICATES = new Set([
  "guarantee", "guarantees", "guaranteed", "certain", "certainly",
  "surefire", "definitely",
]);
const COPULAR_WORDS = new Set([
  "is", "are", "was", "were", "be", "seems", "remains", "looks",
]);
const NEGATION_MODIFIERS = new Set([
  "absolutely", "necessarily", "ever", "fully", "completely", "really",
]);
const SAFE_LEADING_MARKET_NOUNS = /^(?:trade\s+volume|short\s+interest|open\s+interest)\b/;
const LEADING_ACTION = /^(?:please\s+)?(buy|sell|hold|short|trade|enter|exit|purchase|acquire|dispose|open|close)\b(?:\s+(.*))?$/;
const ACTIONABLE_OBJECT = /\b(?:shares?|stocks?|securities|security|assets?|position|trade|market|orders?)\b/;
const ACTION_TIMING = /\b(?:now|today|immediately)\b/;
const MAX_POLICY_BODY_CHARS = 20_000;
const MAX_POLICY_CLAIMS = 512;

function normalizeUnicode(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "");
}

/**
 * Collapses only a bounded repeated single-letter separator sequence, such as
 * `g.u.a.r.a.n.t.e.e.d` or `b.υ.y`. A single separator between full words is
 * never removed, so `guaranteed.Outcome` retains its sentence boundary.
 */
function collapseIntrawordObfuscation(value: string): string {
  return value.replace(
    /(^|[^\p{L}\p{N}])((?:[\p{L}\p{N}][._/\\\-\u2010-\u2015]){2,}[\p{L}\p{N}])(?=$|[^\p{L}\p{N}])/gu,
    (_match, prefix: string, sequence: string) =>
      prefix + sequence.replace(/[._/\\\-\u2010-\u2015]/gu, ""),
  );
}

function normalizeWords(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePolicyText(value: string): PolicyText {
  const deobfuscated = collapseIntrawordObfuscation(normalizeUnicode(value));
  const clauses = deobfuscated
    .split(/[.!?;:\r\n]+|,\s*|\b(?:and|but|because|since|although|while|though|whereas|however|yet|or)\b/giu)
    .map((source): PolicyClause => {
      const trimmedSource = source.trim();
      const lower = trimmedSource.toLocaleLowerCase("en-US");
      const words = normalizeWords(lower);
      return {
        words,
        compact: words.replace(/\s+/g, ""),
      };
    })
    .filter((clause) => clause.words.length > 0);
  return {
    deobfuscated,
    clauses,
  };
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function containsProtectedConfusableLexeme(text: PolicyText): boolean {
  const tokens = text.deobfuscated
    .toLocaleLowerCase("en-US")
    .match(/\p{L}+/gu) ?? [];
  return tokens.some((token) => {
    if (!/[\p{Script=Greek}\p{Script=Cyrillic}]/u.test(token)) {
      return false;
    }
    const skeleton = [...token]
      .map((character) => CONFUSABLE_TO_LATIN[character] ?? character)
      .join("");
    return PROTECTED_CONFUSABLE_LEXEMES.has(skeleton);
  });
}

function isLocallyNegated(tokens: readonly string[], predicateIndex: number): boolean {
  let cursor = predicateIndex - 1;
  let skippedModifiers = 0;
  while (
    cursor >= 0
    && skippedModifiers < 2
    && NEGATION_MODIFIERS.has(tokens[cursor])
  ) {
    cursor -= 1;
    skippedModifiers += 1;
  }
  if (tokens[cursor] === "not" || tokens[cursor] === "never") {
    return true;
  }
  if (tokens[cursor] === "cannot" || tokens[cursor] === "cant") {
    return true;
  }
  if (
    tokens[cursor] === "be"
    && (tokens[cursor - 1] === "cannot" || tokens[cursor - 1] === "cant")
  ) {
    return true;
  }

  // `no` negates certainty only in the grammatical subject construction
  // "no <outcome> is/was/... certain|guaranteed". Nearby phrases such as
  // "no doubt profit is guaranteed" are intentionally not treated as negation.
  cursor = predicateIndex - 1;
  while (cursor >= 0 && NEGATION_MODIFIERS.has(tokens[cursor])) {
    cursor -= 1;
  }
  if (!COPULAR_WORDS.has(tokens[cursor])) {
    return false;
  }
  const outcomeIndex = cursor - 1;
  return OUTCOME_TERMS.has(tokens[outcomeIndex])
    && tokens[outcomeIndex - 1] === "no";
}

function hasCertaintyOutcome(
  tokens: readonly string[],
  predicateIndex: number,
  predicate: string,
): boolean {
  if (predicate === "certain") {
    const next = tokens[predicateIndex + 1];
    if (next !== undefined && OUTCOME_TERMS.has(next)) {
      return true;
    }
    const localBefore = tokens.slice(Math.max(0, predicateIndex - 4), predicateIndex);
    return localBefore.some((token) => OUTCOME_TERMS.has(token))
      && localBefore.some((token) => COPULAR_WORDS.has(token));
  }
  const local = tokens.slice(
    Math.max(0, predicateIndex - 6),
    Math.min(tokens.length, predicateIndex + 7),
  );
  return local.some((token) => OUTCOME_TERMS.has(token));
}

function containsUnqualifiedCertaintyClaim(text: PolicyText): boolean {
  if (text.clauses.length > MAX_POLICY_CLAIMS) {
    return true;
  }
  return text.clauses.some((clause) => {
    const tokens = clause.words.split(" ");
    return tokens.some((token, index) => CERTAINTY_PREDICATES.has(token)
      && hasCertaintyOutcome(tokens, index, token)
      && !isLocallyNegated(tokens, index));
  });
}

function containsLeadingActionInstruction(clause: PolicyClause): boolean {
  if (SAFE_LEADING_MARKET_NOUNS.test(clause.words)) {
    return false;
  }
  const match = LEADING_ACTION.exec(clause.words);
  if (match === null) {
    return false;
  }
  const remainder = match[2] ?? "";
  if (ACTION_TIMING.test(remainder) || ACTIONABLE_OBJECT.test(remainder)) {
    return true;
  }

  // A bare normalized token after a leading transitive market action is its
  // direct object. Capitalization is not an authorization or safety boundary;
  // `buy AAPL`, `buy aapl`, and mixed-case forms are the same directive.
  const [candidate = ""] = remainder.split(" ");
  return /^[a-z][a-z0-9]{0,9}$/u.test(candidate);
}

function clauseViolatesActionPolicy(clause: PolicyClause): boolean {
  const compactWords = ` ${clause.compact} `;
  const directCompactInstruction = [
    "youshouldbuy",
    "youshouldsell",
    "youshouldhold",
    "youneedtobuy",
    "youneedtosell",
    "youneedtohold",
    "buynow",
    "sellnow",
    "holdnow",
  ].some((phrase) => compactWords.includes(phrase));
  const personalizedAction = PERSONAL_CONTEXT_PATTERN.test(clause.words)
    && ACTION_WORD_PATTERN.test(clause.words);

  return directCompactInstruction
    || containsLeadingActionInstruction(clause)
    || personalizedAction
    || matchesAny(clause.words, IMPOSSIBLE_RISK_PATTERNS)
    || matchesAny(clause.words, DIRECT_ACTION_PATTERNS)
    || matchesAny(clause.words, EXECUTION_PATTERNS)
    || matchesAny(clause.words, REAL_TRADE_PATTERNS)
    || matchesAny(clause.words, SENSITIVE_EXECUTION_PATTERNS);
}

/**
 * Rejects real-action language at the canonical Main broadcast boundary.
 * This deterministic guard complements model moderation; it makes no external call.
 */
export function assertBroadcastEditorialPolicy(body: string): void {
  if (body.length > MAX_POLICY_BODY_CHARS) {
    throw new Error(BROADCAST_POLICY_ERROR);
  }
  const normalized = normalizePolicyText(body);

  if (
    containsProtectedConfusableLexeme(normalized)
    || containsUnqualifiedCertaintyClaim(normalized)
    || normalized.clauses.some(clauseViolatesActionPolicy)
  ) {
    throw new Error(BROADCAST_POLICY_ERROR);
  }
}
