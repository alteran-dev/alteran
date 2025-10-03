import type { SSRManifest } from 'astro';

declare module '@astrojs-manifest' {
  export const manifest: SSRManifest;
  export default manifest;
}
