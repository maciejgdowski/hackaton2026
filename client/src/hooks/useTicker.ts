import { useEffect, useState } from 'react';

/** Re-renders the component every `ms` (for countdowns and live sonar readings). */
export function useTicker(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}
