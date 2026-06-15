import type { Metadata } from "next";
import "./globals.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Canger CineFlow | 苍洱影绘 AI 视频创作台",
  description: "Canger CineFlow | 苍洱影绘 720P/1080P 异步视频生成工作台。"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
