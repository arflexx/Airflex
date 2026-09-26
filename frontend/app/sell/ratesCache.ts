let cachedConversionRate: number | null = null;

export function getCachedConversionRate(): number | null {
  return cachedConversionRate;
}

export function setCachedConversionRate(rate: number | null): void {
  cachedConversionRate = rate;
}

export function resetConversionRateCache(): void {
  cachedConversionRate = null;
}
