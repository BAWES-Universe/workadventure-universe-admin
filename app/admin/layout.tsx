import { ReactNode } from 'react';
import { ThemeProvider } from './components/theme-provider';
import ToastWrapper from './components/toast-wrapper';
import AdminShell from './admin-shell';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
      <ToastWrapper><AdminShell>{children}</AdminShell></ToastWrapper>
    </ThemeProvider>
  );
}
