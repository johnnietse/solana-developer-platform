import type { RampProviderId } from "./provider-access";

export const ONRAMP_CRYPTO_RAILS = [
  "sol.solana",
  "usdc.solana",
  "usdt.solana",
  "usdg.solana",
  "pyusd.solana",
] as const;
export type CryptoRailId = (typeof ONRAMP_CRYPTO_RAILS)[number];

export const FIAT_CURRENCIES = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP",
  "CRC", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ETB", "EUR",
  "FJD", "FKP", "GBP", "GEL", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD",
  "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "ISK", "JMD", "JOD", "JPY",
  "KES", "KGS", "KHR", "KMF", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP",
  "LKR", "LRD", "LSL", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP",
  "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK",
  "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SEK", "SGD", "SHP",
  "SLE", "SOS", "SRD", "STD", "SZL", "THB", "TJS", "TOP", "TRY", "TTD",
  "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VND", "VUV", "WST",
  "XAF", "XCD", "XOF", "XPF", "YER", "ZAR", "ZMW",
] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

const FIAT_CURRENCY_SET: ReadonlySet<FiatCurrency> = new Set(FIAT_CURRENCIES);

export function isFiatCurrency(value: string): value is FiatCurrency {
  return FIAT_CURRENCY_SET.has(value as FiatCurrency);
}

export function parseFiatCurrency(raw: string): FiatCurrency | null {
  const upper = raw.trim().toUpperCase();
  return isFiatCurrency(upper) ? upper : null;
}

export interface OnrampPairSupport {
  source: FiatCurrency;
  dest: CryptoRailId;
  providers: readonly RampProviderId[];
}
