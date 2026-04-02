import "./globals.css";

export const metadata = {
  title: "HSE Score Tracker",
  description: "AI-powered HSE inspection score extraction and tracking",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
