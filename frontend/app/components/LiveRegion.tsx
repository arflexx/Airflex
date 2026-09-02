'use client';

import { useEffect, useRef } from 'react';

interface LiveRegionProps {
  message: string;
  politeness?: 'polite' | 'assertive';
  clearDelay?: number;
}

/**
 * LiveRegion component for announcing dynamic content changes to screen readers
 * 
 * @param message - The message to announce
 * @param politeness - 'polite' (default) for non-urgent updates, 'assertive' for important/urgent updates
 * @param clearDelay - Time in ms to clear the message (default: 1000ms), prevents repeated announcements
 */
export default function LiveRegion({ 
  message, 
  politeness = 'polite', 
  clearDelay = 1000 
}: LiveRegionProps) {
  const messageRef = useRef<string>('');
  const timeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    // Only announce if message actually changed
    if (message && message !== messageRef.current) {
      messageRef.current = message;
      
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      
      // Schedule message clearing to prevent repeated announcements
      if (clearDelay > 0) {
        timeoutRef.current = setTimeout(() => {
          messageRef.current = '';
        }, clearDelay);
      }
    }
    
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [message, clearDelay]);

  if (!message) return null;

  return (
    <div
      role="status"
      aria-live={politeness}
      aria-atomic="true"
      className="sr-only"
    >
      {message}
    </div>
  );
}