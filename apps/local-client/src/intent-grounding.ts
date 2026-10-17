import { formatAmount, toAtomic, type AiIntent } from '@rgb-exchange/contracts';

export class IntentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentValidationError';
  }
}

type Asset = { key: string; symbol: string; precision: number };

/** Strip only insignificant zeros. Never round a model-produced amount. */
export function canonicalDecimal(value: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || value.length > 80)
    throw new IntentValidationError(
      'Use an explicit non-negative decimal amount without exponents or separators.',
    );
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

/** Keep fee/reserve numbers outside the two trade sides before model generation. */
export function fixedGoalSides(goal: string): { give: string; receive: string } | null {
  const trade = /\b(sell|swap|exchange|give|buy|receive)\b\s+(.+?)(?:[.!?](?=\s|$)|$)/i.exec(goal);
  if (!trade) return null;
  if (/\b(?:not|don't|never)\s*$/i.test(goal.slice(0, trade.index))) return null;
  const remaining = goal
    .slice(trade.index + trade[0].length)
    .replace(/\b(?:do not|don't|never) sell BTC\b/gi, '');
  if (/\b(?:sell|swap|exchange|give|buy|receive)\b/i.test(remaining)) return null;
  const terms = trade[2].split(/\b(?:fee|maximum|keep|reserve|do not)\b/i)[0];
  if (/\b(?:or|instead)\b/i.test(terms)) return null;
  const halves = terms.split(/\b(?:for|with|to receive|in exchange for)\b/i);
  if (halves.length !== 2) return null;
  const buying = /^(buy|receive)$/i.test(trade[1]);
  return { give: halves[buying ? 1 : 0], receive: halves[buying ? 0 : 1] };
}

export function literalAmounts(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/(?<![\w.,+-])(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?![\w.])/g)].map(
        (match) => match[0],
      ),
    ),
  ];
}

/**
 * Ground a fixed English swap in its literal quantities before converting units.
 * Qwen chooses the intent; this guard refuses unsupported/ambiguous phrasing rather
 * than trusting its arithmetic, a guessed exchange rate, or a reversed direction.
 */
export function groundIntentAmounts(intent: AiIntent, goal: string, assets: Asset[]): AiIntent {
  if (
    intent.clarification ||
    !intent.giveAssetKey ||
    !intent.receiveAssetKey ||
    intent.giveAmount === null ||
    intent.minReceiveAmount === null
  )
    return intent;

  const fail = () => {
    throw new IntentValidationError(
      'Could not verify the requested amounts, units, and direction. Use "Sell 10 X for at least 10000 sats of BTC. Maximum fee 1000 sats." or fill in the terms manually.',
    );
  };
  const sides = fixedGoalSides(goal);
  if (!sides) return fail();

  const ground = (key: string, modelAmount: string, source: string): string => {
    const asset = assets.find((entry) => entry.key === key);
    if (
      !asset ||
      assets.filter((entry) => entry.symbol.toLowerCase() === asset.symbol.toLowerCase()).length !==
        1
    )
      return fail();
    const symbol = asset.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Only the verified BTC identity accepts satoshi aliases, never an RGB ticker.
    const btc = asset.key.endsWith(':btc:btc');
    const unit = btc ? `(?:${symbol}|satoshis?|sats?)` : symbol;
    const matches = [
      ...source.matchAll(
        new RegExp(`(?<![\\w.,+\\-])([0-9]+(?:\\.[0-9]+)?)\\s+(${unit})(?![\\w])`, 'gi'),
      ),
    ];
    if (matches.length !== 1) return fail();
    const raw = canonicalDecimal(matches[0][1]);
    const sats = btc && /^sat/i.test(matches[0][2]);
    let atomic: string;
    try {
      atomic = toAtomic(raw, sats ? 0 : asset.precision);
    } catch {
      throw new IntentValidationError(
        `${asset.symbol} amount has unsupported precision. ${sats ? 'Sats must be whole numbers.' : `This asset supports ${asset.precision} decimal places.`}`,
      );
    }
    const human = formatAmount(atomic, asset.precision);
    const proposed = canonicalDecimal(modelAmount);
    // Accept a literal copy or exact BTC/sats conversion; never guess units
    // from the magnitude of a number. The source unit alone selects conversion.
    if (proposed !== raw && proposed !== human && !(btc && proposed === atomic)) return fail();
    return human;
  };

  const giveAmount = ground(intent.giveAssetKey, intent.giveAmount, sides.give);
  const minReceiveAmount = ground(intent.receiveAssetKey, intent.minReceiveAmount, sides.receive);
  const fees = [
    ...goal.matchAll(
      /\b(?:maximum(?: transaction)? fee|(?:max(?:imum)?\s+)?fee(?:\s+(?:up to|limit))?)\s*:?\s*([0-9]+)\s*sats?\b/gi,
    ),
  ];
  // An explicit fee clause must not disappear into the saved default.
  if (
    fees.length !== [...goal.matchAll(/\bfees?\b/gi)].length ||
    fees.length > 1 ||
    (fees.length === 1 && intent.maxFeeSats !== fees[0][1])
  )
    return fail();
  return { ...intent, giveAmount, minReceiveAmount };
}
