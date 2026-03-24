import type { Metadata, Viewport } from "next";
import { ErrorLogger } from "@/components/error-logger";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thinkarr",
  description: "LLM-powered media management assistant",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Thinkarr",
  },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ErrorLogger />
        {children}
      </body>
    </html>
  );
}
