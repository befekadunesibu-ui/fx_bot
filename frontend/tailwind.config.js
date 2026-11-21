/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: { navy: '#07111f', panel: '#0d1a2c', purple: '#8b5cf6', cyan: '#38bdf8' },
      boxShadow: { glow: '0 0 36px rgba(99, 102, 241, 0.18)' },
    },
  },
  plugins: [],
};
