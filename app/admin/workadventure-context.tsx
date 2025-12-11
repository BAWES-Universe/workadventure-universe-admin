'use client';

import { createContext, useContext, ReactNode } from 'react';
import type { WorkAdventure } from '@workadventure/iframe-api-typings';

export interface WorkAdventureContextValue {
  wa: WorkAdventure | null;
  isReady: boolean;
  isLoading: boolean;
  error: Error | null;
  navigateToRoom: (roomUrl: string) => Promise<void>;
}

const WorkAdventureContext = createContext<WorkAdventureContextValue | undefined>(undefined);

export function useWorkAdventure() {
  const context = useContext(WorkAdventureContext);
  if (context === undefined) {
    throw new Error('useWorkAdventure must be used within a WorkAdventureProvider');
  }
  return context;
}

export { WorkAdventureContext };

