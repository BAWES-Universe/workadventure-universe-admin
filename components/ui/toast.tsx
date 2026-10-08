'use client';

import * as React from 'react';
import { CheckCircle2, XCircle, AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Toast {
  id: string;
  title?: string;
  description: string;
  variant?: 'default' | 'success' | 'error';
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const removeToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const addToast = React.useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substring(7);
    const newToast = { ...toast, id };
    setToasts((prev) => [...prev, newToast]);

    const duration = toast.duration ?? 3000;
    setTimeout(() => {
      removeToast(id);
    }, duration);
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}

function ToastContainer({ toasts, removeToast }: { toasts: Toast[]; removeToast: (id: string) => void }) {
  // As wide as the screen allows less a 1rem margin each side, so on a phone or the game's side panel it never
  // runs off the left edge.
  return (
    <div className="fixed top-4 right-4 z-[100] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const variant = toast.variant ?? 'default';

  const icons = {
    success: CheckCircle2,
    error: XCircle,
    default: AlertCircle,
  };

  const Icon = icons[variant];

  // Every toast is the game's raised ink with white text and a white icon, in the light theme too (like the dock).
  // A success keeps the violet edge and purple glow; an error swaps them for a coral edge.
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn('orbit-toast flex items-center gap-3 rounded-2xl py-2.5 pl-4 pr-2 animate-in slide-in-from-top-5', variant === 'error' && 'orbit-toast-error')}
    >
      <Icon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        {toast.title && <div className="font-semibold text-sm mb-1">{toast.title}</div>}
        <div className="text-sm font-medium">{toast.description}</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full text-white/60 transition-colors hover:text-white"
      >
        <X className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}
