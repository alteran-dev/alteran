import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import icon from 'astro-icon';
import alteran from './index.js';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({ mode: 'advanced', imageService: 'custom' }),
  server: { host: true },
  image: {
    service: {
      entrypoint: '@astrojs/cloudflare/image-service',
    },
  },
  integrations: [icon(), alteran({ debugRoutes: true, includeRootEndpoint: true })],
});
