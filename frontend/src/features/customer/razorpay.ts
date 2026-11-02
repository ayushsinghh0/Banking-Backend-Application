/**
 * The small part of Razorpay Checkout (checkout.js) the app uses, typed. The script is third-party, so it is
 * loaded only when a customer actually pays (never on page load), once per page, and only in live or test
 * mode; nginx allows it in the CSP only when RAZORPAY_CHECKOUT=on.
 */

export interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

export interface RazorpayFailure {
  error?: {
    code?: string;
    description?: string;
    source?: string;
    step?: string;
    reason?: string;
    metadata?: { order_id?: string; payment_id?: string };
  };
}

export interface RazorpayOptions {
  key: string;
  order_id: string;
  /** Paise */
  amount: string | number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { email?: string; name?: string; contact?: string };
  theme?: { color?: string };
  /** Called with the signed result after a successful payment */
  handler: (response: RazorpayPaymentResponse) => void;
  modal?: { ondismiss?: () => void; escape?: boolean; confirm_close?: boolean };
}

export interface RazorpayInstance {
  open(): void;
  close(): void;
  on(event: 'payment.failed', handler: (response: RazorpayFailure) => void): void;
}

export type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

export const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

let loading: Promise<RazorpayConstructor> | null = null;

/** Loads checkout.js the first time it is needed; concurrent and later calls share the same load */
export function loadRazorpayCheckout(timeoutMs = 20_000): Promise<RazorpayConstructor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  loading ??= new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      loading = null;
      reject(new Error('Razorpay Checkout could not be loaded'));
    };
    const timer = setTimeout(fail, timeoutMs);
    script.addEventListener('load', () => {
      if (!window.Razorpay) {
        fail();
        return;
      }
      clearTimeout(timer);
      resolve(window.Razorpay);
    });
    script.addEventListener('error', fail);
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    document.head.appendChild(script);
  });
  return loading;
}

/** Tests only: forget a finished load */
export function resetRazorpayLoader(): void {
  loading = null;
}
