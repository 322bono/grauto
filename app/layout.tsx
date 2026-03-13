import type { Metadata } from "next";
import { Gaegu, Noto_Sans_KR, Space_Grotesk } from "next/font/google";
import "./globals.css";

const bodyFont = Noto_Sans_KR({
  variable: "--font-body",
  preload: false,
  weight: ["400", "500", "700", "900"]
});

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "700"]
});

const handFont = Gaegu({
  variable: "--font-hand",
  preload: false,
  weight: ["400", "700"]
});

export const metadata: Metadata = {
  title: "Grauto",
  description: "PDF 자동 채점과 해설 분석을 위한 Grauto"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body suppressHydrationWarning className={`${bodyFont.variable} ${displayFont.variable} ${handFont.variable}`}>
        {children}
      </body>
    </html>
  );
}
