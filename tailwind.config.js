/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      keyframes: {
        'ambient-breathe': {
          '0%, 100%': { backgroundPosition: '48% 50%' },
          '50%': { backgroundPosition: '52% 50%' },
        },
        'halo-pulse': {
          '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
          '50%': { opacity: '0.7', transform: 'scale(1.05)' },
        },
        'soft-shimmer': {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'ambient-breathe': 'ambient-breathe var(--breathe-slow) ease-in-out infinite',
        'halo-pulse': 'halo-pulse var(--breathe-medium) ease-in-out infinite',
        'soft-shimmer': 'soft-shimmer var(--breathe-fast) ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
