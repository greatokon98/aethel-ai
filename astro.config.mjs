import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';

export default defineConfig({
  output: 'static',
  integrations: [mdx(), react()],
  site: 'https://aethel-ai.netlify.app',
  compressHTML: true,
  devToolbar: {
    enabled: false,
  },
});
