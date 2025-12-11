'use client';

import { useState, useEffect, useCallback, ReactNode } from 'react';
import Script from 'next/script';
import { WorkAdventureContext, type WorkAdventureContextValue } from './workadventure-context';
import type { WorkAdventureApi } from '@workadventure/iframe-api-typings';

interface WorkAdventureProviderProps {
  children: ReactNode;
}

export default function WorkAdventureProvider({ children }: WorkAdventureProviderProps) {
  const defaultPlayUrl = process.env.NEXT_PUBLIC_PLAY_URL || 'http://play.workadventure.localhost';
  const [wa, setWa] = useState<WorkAdventureApi | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [playUrl, setPlayUrl] = useState<string>(defaultPlayUrl);

  // Detect the play URL from iframe context
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let detectedPlayUrl = defaultPlayUrl;
    const currentOrigin = window.location.origin;

    try {
      // Check if we're in an iframe
      if (window.self !== window.top) {
        // We're in an iframe - try to get parent origin
        try {
          const parentOrigin = window.parent.location.origin;
          console.log('[WorkAdventureProvider] Detected parent origin:', parentOrigin);
          // Only use parent origin if it's different from current (and looks like a play URL)
          if (parentOrigin !== currentOrigin && (parentOrigin.includes('play') || parentOrigin.includes('workadventure') || parentOrigin.includes('bawes'))) {
            detectedPlayUrl = parentOrigin;
          }
        } catch (e) {
          // Cross-origin restriction - can't access parent.location
          console.log('[WorkAdventureProvider] Cannot access parent.location (cross-origin), trying referrer...');
          
          if (document.referrer) {
            try {
              const referrerUrl = new URL(document.referrer);
              const referrerOrigin = referrerUrl.origin;
              // Only use referrer if it's different from current and looks like a play URL
              if (referrerOrigin !== currentOrigin && (referrerOrigin.includes('play') || referrerOrigin.includes('workadventure') || referrerOrigin.includes('bawes'))) {
                console.log('[WorkAdventureProvider] Detected origin from referrer:', referrerOrigin);
                detectedPlayUrl = referrerOrigin;
              }
            } catch (referrerError) {
              console.warn('[WorkAdventureProvider] Failed to parse referrer URL:', document.referrer);
            }
          }
        }
      } else {
        // Not in an iframe - check referrer but be more strict
        if (document.referrer) {
          try {
            const referrerUrl = new URL(document.referrer);
            const referrerOrigin = referrerUrl.origin;
            // Only use referrer if it's different from current and clearly a play URL
            if (referrerOrigin !== currentOrigin && 
                (referrerUrl.hostname.includes('play') || 
                 (referrerUrl.hostname.includes('workadventure') && !referrerUrl.hostname.includes('admin')) ||
                 (referrerUrl.hostname.includes('bawes') && referrerUrl.hostname.includes('play')))) {
              console.log('[WorkAdventureProvider] Detected origin from referrer (not in iframe):', referrerOrigin);
              detectedPlayUrl = referrerOrigin;
            }
          } catch (referrerError) {
            // Ignore referrer parsing errors
          }
        }
      }
    } catch (error) {
      console.warn('[WorkAdventureProvider] Error detecting play URL, using default:', error);
    }

    console.log('[WorkAdventureProvider] Using play URL for iframe API:', detectedPlayUrl);
    if (detectedPlayUrl !== playUrl) {
      setPlayUrl(detectedPlayUrl);
      // Reset states when URL changes
      setScriptLoaded(false);
      setIsReady(false);
      setWa(null);
    }
  }, [defaultPlayUrl, playUrl]);

  // Check if WA is already available on mount (e.g., after navigation)
  useEffect(() => {
    if (typeof window === 'undefined' || !playUrl) {
      return;
    }

    // If WA is already available, we don't need to wait for script load
    if (window.WA) {
      console.log('[WorkAdventureProvider] WA already available on mount');
      setScriptLoaded(true);
      setWa(window.WA);
      
      // Try to initialize immediately
      window.WA.onInit()
        .then(() => {
          console.log('[WorkAdventureProvider] WA initialized on mount');
          setIsReady(true);
          setIsLoading(false);
        })
        .catch((err) => {
          console.warn('[WorkAdventureProvider] WA initialization failed on mount:', err);
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        });
      return;
    }

    // Check if the script is already in the DOM (cached/loaded)
    const scriptExists = document.querySelector(`script[src*="iframe_api.js"]`);
    if (scriptExists) {
      console.log('[WorkAdventureProvider] Script already in DOM, marking as loaded');
      setScriptLoaded(true);
    }
  }, [playUrl]);

  // Check for WorkAdventure iframe API after script loads
  useEffect(() => {
    if (!scriptLoaded || typeof window === 'undefined') {
      return;
    }

    async function checkWorkAdventure() {
      console.log('[WorkAdventureProvider] Checking for WorkAdventure API (after script load)...');
      
      let attempts = 0;
      const maxAttempts = 10;
      const checkInterval = 100; // ms
      
      const checkForWA = async () => {
        attempts++;
        console.log(`[WorkAdventureProvider] Attempt ${attempts}: window.WA available:`, !!window.WA);
        
        if (window.WA) {
          console.log('[WorkAdventureProvider] WA found, waiting for initialization...');
          setWa(window.WA);
          try {
            await window.WA.onInit();
            console.log('[WorkAdventureProvider] WA initialized successfully');
            setIsReady(true);
            setIsLoading(false);
            setError(null);
            return true;
          } catch (err) {
            console.error('[WorkAdventureProvider] Failed to initialize WorkAdventure API:', err);
            setError(err instanceof Error ? err : new Error(String(err)));
            setIsLoading(false);
            return false;
          }
        }
        
        if (attempts < maxAttempts) {
          setTimeout(checkForWA, checkInterval);
          return false;
        } else {
          console.log('[WorkAdventureProvider] WA not available after script load - page may not be loaded in WorkAdventure iframe');
          setError(new Error('WorkAdventure API not available - page may not be loaded in WorkAdventure iframe'));
          setIsLoading(false);
          return false;
        }
      };
      
      checkForWA();
    }

    checkWorkAdventure();
  }, [scriptLoaded]);

  const navigateToRoom = useCallback(async (roomUrl: string) => {
    if (!wa) {
      throw new Error('WorkAdventure API is not available');
    }

    try {
      // Ensure WA is initialized
      await wa.onInit();
      setIsReady(true);
      
      // Navigate to the room
      wa.nav.goToRoom(roomUrl);
      console.log('[WorkAdventureProvider] Navigation command sent to:', roomUrl);
    } catch (err) {
      console.error('[WorkAdventureProvider] Failed to navigate to room:', err);
      throw err;
    }
  }, [wa]);

  const contextValue: WorkAdventureContextValue = {
    wa,
    isReady,
    isLoading,
    error,
    navigateToRoom,
  };

  return (
    <>
      <Script
        key={playUrl}
        src={`${playUrl}/iframe_api.js`}
        strategy="afterInteractive"
        onLoad={() => {
          console.log('[WorkAdventureProvider] WorkAdventure iframe API script loaded from:', playUrl);
          setScriptLoaded(true);
        }}
        onError={(e) => {
          console.error('[WorkAdventureProvider] Failed to load WorkAdventure iframe API script from:', playUrl, e);
          setError(new Error(`Failed to load WorkAdventure iframe API script from ${playUrl}`));
          setScriptLoaded(true); // Set to true even on error so we don't wait forever
          setIsLoading(false);
        }}
      />
      <WorkAdventureContext.Provider value={contextValue}>
        {children}
      </WorkAdventureContext.Provider>
    </>
  );
}

