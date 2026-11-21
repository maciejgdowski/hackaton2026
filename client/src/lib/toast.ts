// One toast message at a time, shown by <ErrorToast />. Callable from anywhere.
import { useSyncExternalStore } from 'react';

const VISIBLE_MS = 5000;

let message = '';
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function showError(text: string) {
  clearTimeout(timer);
  message = text;
  notify();
  if (text) timer = setTimeout(() => showError(''), VISIBLE_MS);
}

/** Shows the message of a caught error (or a fallback). */
export const showCaught = (error: unknown, fallback = 'Something went wrong.') =>
  showError(error instanceof Error && error.message ? error.message : fallback);

export function useToast(): string {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => message);
}
