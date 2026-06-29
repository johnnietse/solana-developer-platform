import type { Metadata } from "next";
import { Toaster } from "sonner";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const ALLOWED_SATELLITE_REDIRECT_ORIGINS = [
  "https://ecosystem.solana.com",
  "https://bookface-git-main-solana-foundation.vercel.app",
];

export const metadata: Metadata = {
  title: "Solana Developer Platform",
  description: "SDP dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      allowedRedirectOrigins={ALLOWED_SATELLITE_REDIRECT_ORIGINS}
      afterSignOutUrl="/sign-in"
    >
      <html lang="en" suppressHydrationWarning>
        <body>
          {children}
          <Toaster position="bottom-right" richColors closeButton />
        </body>
      </html>
    </ClerkProvider>
  );
}
