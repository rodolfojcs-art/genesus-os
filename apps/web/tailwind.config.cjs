/** Tokens Genesus (identidad §3) mapeados a Tailwind. Fondos claros siempre. */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        indigo: '#7B68FF',
        teal: '#00D4A0',
        gold: '#FFC040',
        rose: '#F06292',
        ink: '#14121F',
        muted: '#6B6A85',
        bg: '#FAFBFC',
        surface: '#FFFFFF',
        surface2: '#F0F4F8',
        line: '#E8E6F2',
        line2: '#D9D6EA',
        'indigo-soft': '#F1EEFF',
        'teal-soft': '#E5FBF5',
        'gold-soft': '#FFF6E0',
        'rose-soft': '#FDEDF3',
      },
      fontFamily: {
        display: ['Syne', 'sans-serif'],
        body: ['Outfit', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        card: '14px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(20,18,31,.04), 0 8px 24px rgba(123,104,255,.07)',
      },
    },
  },
  plugins: [],
};
