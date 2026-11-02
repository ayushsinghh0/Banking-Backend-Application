import { afterEach, describe, expect, it } from 'vitest';
import { CHECKOUT_SCRIPT, loadRazorpayCheckout, resetRazorpayLoader, type RazorpayConstructor } from './razorpay';

const scripts = () => document.querySelectorAll<HTMLScriptElement>(`script[src="${CHECKOUT_SCRIPT}"]`);
const FakeRazorpay = function FakeRazorpay() {} as unknown as RazorpayConstructor;

afterEach(() => {
  resetRazorpayLoader();
  delete window.Razorpay;
  for (const script of scripts()) script.remove();
});

describe('loadRazorpayCheckout', () => {
  it('adds the Checkout script once, on demand, and resolves with Razorpay when it loads', async () => {
    expect(scripts()).toHaveLength(0);
    const first = loadRazorpayCheckout();
    const second = loadRazorpayCheckout();
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]!.async).toBe(true);
    window.Razorpay = FakeRazorpay;
    scripts()[0]!.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBe(FakeRazorpay);
    await expect(second).resolves.toBe(FakeRazorpay);
    // Later calls use what is already on the page
    await expect(loadRazorpayCheckout()).resolves.toBe(FakeRazorpay);
    expect(scripts()).toHaveLength(1);
  });

  it('fails when the script cannot load, and tries again next time', async () => {
    const attempt = loadRazorpayCheckout();
    scripts()[0]!.dispatchEvent(new Event('error'));
    await expect(attempt).rejects.toThrow(/could not be loaded/i);
    expect(scripts()).toHaveLength(0);
    const retry = loadRazorpayCheckout();
    expect(scripts()).toHaveLength(1);
    window.Razorpay = FakeRazorpay;
    scripts()[0]!.dispatchEvent(new Event('load'));
    await expect(retry).resolves.toBe(FakeRazorpay);
  });

  it('fails if the script loads without defining Razorpay', async () => {
    const attempt = loadRazorpayCheckout();
    scripts()[0]!.dispatchEvent(new Event('load'));
    await expect(attempt).rejects.toThrow(/could not be loaded/i);
  });

  it('gives up after the timeout', async () => {
    await expect(loadRazorpayCheckout(10)).rejects.toThrow(/could not be loaded/i);
    expect(scripts()).toHaveLength(0);
  });
});
