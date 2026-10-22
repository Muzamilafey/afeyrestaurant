/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#07963C', dark: '#087B35', pale: '#D8F0DF', 50: '#EEF8F1' },
        page: '#F3F5F4',
        card: '#FFFFFF',
        ink: { DEFAULT: '#171A18', soft: '#737A75' },
        line: '#E4E8E5',
        warn: { DEFAULT: '#F4B942', pale: '#FDF3DC' },
        danger: { DEFAULT: '#DC4545', pale: '#FBE4E4' },
      },
      fontFamily: { sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'] },
      borderRadius: { xl: '14px', '2xl': '18px' },
      boxShadow: { soft: '0 1px 2px rgba(23,26,24,0.04), 0 4px 14px rgba(23,26,24,0.05)', lift: '0 8px 30px rgba(23,26,24,0.10)' },
    },
  },
  plugins: [],
};
