import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/auth/AuthProvider";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Yolna Runs",
  description: "Yolna Runs — observation, permission, and audit for every AI/agent/SaaS execution.",
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
      <body className="h-full min-h-0 overflow-hidden flex flex-col font-medium">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
