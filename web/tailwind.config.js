/** @type {import('tailwindcss').Config} */
// Colours are CSS variables (RGB channels) so light and dark themes share one set of class names. See src/index.css.
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: v('brand'), dark: v('brand-dark'), pale: v('brand-pale'), 50: v('brand-50') },
        page: v('page'),
        card: v('card'),
        raised: v('raised'),
        ink: { DEFAULT: v('ink'), soft: v('ink-soft') },
        line: v('line'),
        warn: { DEFAULT: v('warn'), pale: v('warn-pale'), ink: v('warn-ink') },
        danger: { DEFAULT: v('danger'), pale: v('danger-pale') },
        info: { DEFAULT: v('info'), pale: v('info-pale') },
      },
      fontFamily: { sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'] },
      borderRadius: { xl: '14px', '2xl': '18px' },
      boxShadow: { soft: '0 1px 2px rgba(0,0,0,0.04), 0 4px 14px rgba(0,0,0,0.05)', lift: '0 8px 30px rgba(0,0,0,0.12)' },
    },
  },
  plugins: [],
};
