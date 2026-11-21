import { useToast } from '../lib/toast.ts';

export function ErrorToast() {
  const message = useToast();
  if (!message) return null;
  return <p id="error" role="alert">{message}</p>;
}
