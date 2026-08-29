import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/auth/AuthProvider";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "tact",
  description: "tact",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-medium">
        {/* STEP132: TACT本体のUI・レイアウトには影響しない、
            session保持のためだけのProvider。 */}
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
