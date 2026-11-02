import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "SLM · Onchain control",
  description: "Local Solana Language Model storage and recovery control panel",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
