import { ReactNode } from 'react';
import { ThemeProvider } from '../components/theme-provider';

export default function LoginLayout({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <div className="min-h-screen bg-background">
        {children}
      </div>
    </ThemeProvider>
  );
}

