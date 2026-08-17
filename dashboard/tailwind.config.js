/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Live Bridge palette - dark control-room surface with a signal-blue accent.
        bridge: {
          bg: '#0b1017',
          surface: '#121a24',
          raised: '#1a2532',
          border: '#243444',
          accent: '#38bdf8',
          accentDim: '#0ea5e9',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
