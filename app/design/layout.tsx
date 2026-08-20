// =========================
// TACT Design layout (STEP42)
// =========================
//
// /design配下だけに適用されるネストしたlayout。TACT本体の
// app/layout.tsx(ルートlayout)はそのまま維持し、ここでは
// ブラウザタブのタイトルだけを分けるために追加する。
// (metadataはServer Componentでのみexportできるため、
// "use client"のapp/design/page.tsxとは別ファイルにしている。)

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TACT Design",
  description:
    "TACT Design: 資料編集画面の横に存在するAI(プロトタイプ)",
};

export default function DesignLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {

  return children;

}
