import type { Metadata } from "next";
import "../globals.css";
import Providers from "../providers";
import AuthGuard from "@/components/AuthGuard";
import RoleLayout from "@/components/RoleLayout";

export const metadata: Metadata = {
  title: "POS - Quản lý quán",
  description: "Hệ thống quản lý bán hàng, kho, sổ quỹ và báo cáo cho một quán.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700&display=swap" rel="stylesheet" />

        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            try {
              var savedTheme = localStorage.getItem('melio_theme');
              var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
              if (savedTheme === 'dark' || (!savedTheme && systemDark)) {
                document.documentElement.classList.add('dark');
              } else if (savedTheme === 'light') {
                document.documentElement.classList.add('light');
              } else {
                document.documentElement.classList.add(systemDark ? 'dark' : 'light');
              }
            } catch (e) {}
          })();
        `}} />
      </head>
      <body className="antialiased bg-slate-950 text-slate-100 min-h-screen">
        <Providers>
          <AuthGuard>
            <RoleLayout>{children}</RoleLayout>
          </AuthGuard>
        </Providers>
      </body>
    </html>
  );
}
