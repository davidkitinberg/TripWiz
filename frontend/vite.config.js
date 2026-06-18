/**
 * @fileoverview Vite build configuration for the TripWiz React frontend.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
  },
});
