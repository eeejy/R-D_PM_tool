import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI·Data R&D Flow",
  description: "CDX 사업담당자의 개인 사업관리 워크스페이스 — 오늘·이번 주 업무와 연구개발 현황을 한 화면에서",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
