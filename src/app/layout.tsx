import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "C-AI",
  description: "C-AI async video generation workbench."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
