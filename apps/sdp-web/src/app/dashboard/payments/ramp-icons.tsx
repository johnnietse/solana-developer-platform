"use client";

import type { CryptoRailId, FiatCurrency, RampProviderId } from "@sdp/types";

// biome-ignore lint/security/noSecrets: logo.dev public token, intended for client-side use
const LOGO_DEV_TOKEN = "pk_AqzdOjoTREaXsEkB9KzTPA";

// ISO 4217 → ISO 3166-1 alpha-2 special cases. Default is `currency.slice(0, 2)`.
const CURRENCY_TO_COUNTRY_CODE: Partial<Record<FiatCurrency, string>> = {
  EUR: "eu",
  XOF: "sn", // West Africa CFA — represent as Senegal
  XAF: "cm", // Central Africa CFA — represent as Cameroon
};

function countryCodeForCurrency(currency: string): string {
  const override = CURRENCY_TO_COUNTRY_CODE[currency as FiatCurrency];
  if (override) {
    return override;
  }
  return currency.slice(0, 2).toLowerCase();
}

export function CurrencyFlag({
  currency,
  className,
}: {
  currency: string;
  className?: string;
}) {
  const cc = countryCodeForCurrency(currency);
  return (
    <img
      src={`https://flagcdn.com/${cc}.svg`}
      alt={`${currency} flag`}
      width={20}
      height={15}
      loading="lazy"
      className={className ?? "h-4 w-5 rounded-[2px] object-cover"}
    />
  );
}

// Rail id shape is `<asset>.<network>`, e.g. "usdc.solana".
function tickerForRail(railId: string): string {
  const [asset] = railId.split(".");
  return (asset ?? railId).toLowerCase();
}

export function CryptoRailIcon({
  railId,
  className,
}: {
  railId: CryptoRailId | string;
  className?: string;
}) {
  const ticker = tickerForRail(railId);
  return (
    <img
      src={`https://img.logo.dev/ticker/${ticker}?token=${LOGO_DEV_TOKEN}&retina=true`}
      alt={`${ticker.toUpperCase()} icon`}
      width={20}
      height={20}
      loading="lazy"
      className={className ?? "h-5 w-5 rounded-full object-cover"}
    />
  );
}

const PROVIDER_LOGO_NAMES: Record<RampProviderId, string> = {
  moonpay: "moonpay",
  lightspark: "lightspark",
  bvnk: "bvnk",
};

export function ProviderLogo({
  providerId,
  className,
}: {
  providerId: RampProviderId;
  className?: string;
}) {
  const name = PROVIDER_LOGO_NAMES[providerId] ?? providerId;
  return (
    <img
      src={`https://img.logo.dev/name/${name}?token=${LOGO_DEV_TOKEN}&retina=true`}
      alt={`${providerId} logo`}
      width={28}
      height={28}
      loading="lazy"
      className={className ?? "h-7 w-7 rounded object-contain"}
    />
  );
}
