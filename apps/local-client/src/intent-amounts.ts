export class IntentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentValidationError';
  }
}

/** Strip only insignificant zeros. Never round a model-produced amount. */
export function canonicalDecimal(value: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || value.length > 80)
    throw new IntentValidationError(
      'Use an explicit non-negative decimal amount without exponents or separators.',
    );
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}
