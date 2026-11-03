import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1440px' } },
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        background: token('background'),
        foreground: token('foreground'),
        canvas: token('canvas'),
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground'), soft: token('primary-soft') },
        secondary: { DEFAULT: token('secondary'), foreground: token('secondary-foreground') },
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground') },
        card: { DEFAULT: token('card'), foreground: token('card-foreground') },
        popover: { DEFAULT: token('popover'), foreground: token('popover-foreground') },
        destructive: { DEFAULT: token('destructive'), foreground: token('destructive-foreground'), soft: token('destructive-soft') },
        success: { DEFAULT: token('success'), foreground: token('success-foreground'), soft: token('success-soft') },
        warning: { DEFAULT: token('warning'), foreground: token('warning-foreground'), soft: token('warning-soft') },
        info: { DEFAULT: token('info'), soft: token('info-soft') },
        /** The selected thumb of a segmented control */
        segment: token('segment'),
        /** Ink: the colour of primary actions (near-black in light mode, near-white in dark) */
        ink: { DEFAULT: token('ink'), foreground: token('ink-foreground') },
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: '10px',
        xl: '14px',
        '2xl': '18px',
        '3xl': '24px',
      },
      boxShadow: {
        // Tiles sit on the canvas almost flat: a hairline of depth, never a drop shadow
        card: '0 0 0 0.5px hsl(var(--shadow-color) / 0.06), 0 1px 2px 0 hsl(var(--shadow-color) / 0.04)',
        raised: '0 0 0 0.5px hsl(var(--shadow-color) / 0.08), 0 2px 8px -2px hsl(var(--shadow-color) / 0.08)',
        elevated: '0 0 0 0.5px hsl(var(--shadow-color) / 0.08), 0 16px 48px -12px hsl(var(--shadow-color) / 0.28)',
        thumb: '0 0 0 0.5px hsl(var(--shadow-color) / 0.04), 0 2px 6px -1px hsl(var(--shadow-color) / 0.14)',
        focus: '0 0 0 4px hsl(var(--ring) / 0.22)',
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        caption: ['0.75rem', { lineHeight: '1rem' }],
        footnote: ['0.8125rem', { lineHeight: '1.125rem' }],
        callout: ['0.9375rem', { lineHeight: '1.375rem' }],
        headline: ['1.0625rem', { lineHeight: '1.5rem', letterSpacing: '-0.012em', fontWeight: '600' }],
        'title-3': ['1.25rem', { lineHeight: '1.625rem', letterSpacing: '-0.017em', fontWeight: '600' }],
        'title-2': ['1.5rem', { lineHeight: '1.875rem', letterSpacing: '-0.021em', fontWeight: '650' }],
        'title-1': ['2rem', { lineHeight: '2.375rem', letterSpacing: '-0.026em', fontWeight: '700' }],
        display: ['2.75rem', { lineHeight: '1', letterSpacing: '-0.034em', fontWeight: '650' }],
        hero: ['3.5rem', { lineHeight: '1', letterSpacing: '-0.04em', fontWeight: '650' }],
      },
      transitionTimingFunction: {
        // Apple's "ease" curve family: fast start, long gentle settle
        out: 'cubic-bezier(0.22, 1, 0.36, 1)',
        spring: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        rise: { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'slide-up': 'slide-up 360ms cubic-bezier(0.22, 1, 0.36, 1)',
        rise: 'rise 280ms cubic-bezier(0.22, 1, 0.36, 1)',
        shimmer: 'shimmer 1.8s infinite',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
