import { toast } from 'sonner';
import { describeOpsError } from './format';

/** Toast for a failed background action, in this area's words, with the support reference when there is one */
export function notifyOpsError(error: unknown): void {
  const { title, description, reference } = describeOpsError(error);
  toast.error(title, { description: reference ? `${description} (Ref: ${reference})` : description });
}
