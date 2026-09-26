import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';

export default defineConfig({
  // ルートロケールがないので `/` にページができない。`/ja/` へ送る。
  redirects: { '/': '/ja/' },
  integrations: [
    starlight({
      title: 'doctrine',
      defaultLocale: 'ja',
      locales: { ja: { label: '日本語', lang: 'ja' } },
      customCss: [
        '@fontsource/ibm-plex-sans-jp/400.css',
        '@fontsource/ibm-plex-sans-jp/500.css',
        '@fontsource/ibm-plex-mono/400.css',
        '@fontsource/ibm-plex-mono/500.css',
        './src/styles/theme.css',
      ],
      // autogenerate にしておくと、ページを足す PR がこの設定を触らずに済む。
      sidebar: [
        { label: 'Quick Start', autogenerate: { directory: 'quick-start' } },
        { label: 'Guide', autogenerate: { directory: 'guide' } },
        { label: 'Concepts', autogenerate: { directory: 'concepts' } },
        { label: 'Examples', autogenerate: { directory: 'examples' } },
      ],
    }),
    react(),
  ],
});
