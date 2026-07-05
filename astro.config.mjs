import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'static',
  adapter: vercel({
    imageService: true,
  }),
  integrations: [mdx(), react()],
  site: 'https://aethel-blog.vercel.app',
  compressHTML: true,
  devToolbar: {
    enabled: false,
  },
});
