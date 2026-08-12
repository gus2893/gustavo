import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  metadataBase: new URL("https://gustavo.lol"),
  title: {
    default: "Gustavo",
    template: "%s | Gustavo",
  },
  description:
    "The market thinks out loud. Educational market commentary from Gustavo.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
