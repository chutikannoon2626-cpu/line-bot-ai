import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'น้องใจดี — Spender Club',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  )
}
