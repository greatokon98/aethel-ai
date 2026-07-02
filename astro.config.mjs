import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import netlify from '@astrojs/netlify';

export default defineConfig({
  output: 'server',
  integrations: [mdx(), react()],
  adapter: netlify(),
  site: 'https://aethel-ai.netlify.app',
  compressHTML: true,
  devToolbar: {
    enabled: false,
  },
});
