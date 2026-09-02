'use client';

import React, { useEffect } from 'react';

export default function AxeDevTools() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      const loadAxe = async () => {
        const axe = await import('@axe-core/react');
        const ReactDOM = await import('react-dom');
        axe.default(React, ReactDOM, 1000);
      };
      loadAxe();
    }
  }, []);

  return null;
}