'use client';

import { createContext, useContext, useRef, ReactNode } from 'react';

interface AnnouncementContextValue {
  announce: (message: string, priority?: 'polite' | 'assertive') => void;
  announceStatus: (message: string) => void;
  announceError: (message: string) => void;
  announceSuccess: (message: string) => void;
}

const AnnouncementContext = createContext<AnnouncementContextValue | null>(null);

export function useAnnouncement() {
  const context = useContext(AnnouncementContext);
  if (!context) {
    throw new Error('useAnnouncement must be used within AnnouncementProvider');
  }
  return context;
}

interface AnnouncementProviderProps {
  children: ReactNode;
}

export function AnnouncementProvider({ children }: AnnouncementProviderProps) {
  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  const announce = (message: string, priority: 'polite' | 'assertive' = 'polite') => {
    const region = priority === 'assertive' ? assertiveRef.current : politeRef.current;
    if (region) {
      // Clear and then set message to ensure it's announced even if the same message repeats
      region.textContent = '';
      setTimeout(() => {
        region.textContent = message;
      }, 50);
      
      // Clear after delay to prevent stale announcements
      setTimeout(() => {
        region.textContent = '';
      }, 3000);
    }
  };

  const announceStatus = (message: string) => {
    if (statusRef.current) {
      statusRef.current.textContent = '';
      setTimeout(() => {
        if (statusRef.current) {
          statusRef.current.textContent = message;
        }
      }, 50);
      
      setTimeout(() => {
        if (statusRef.current) {
          statusRef.current.textContent = '';
        }
      }, 2000);
    }
  };

  const announceError = (message: string) => {
    announce(`Error: ${message}`, 'assertive');
  };

  const announceSuccess = (message: string) => {
    announce(`Success: ${message}`, 'polite');
  };

  return (
    <AnnouncementContext.Provider value={{ 
      announce, 
      announceStatus, 
      announceError, 
      announceSuccess 
    }}>
      {children}
      
      {/* Screen reader announcement regions */}
      <div
        ref={politeRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
      
      <div
        ref={assertiveRef}
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      />
      
      <div
        ref={statusRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
    </AnnouncementContext.Provider>
  );
}