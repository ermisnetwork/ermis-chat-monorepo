import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'Ermis Chat Docs',
  tagline: 'Official documentation for Ermis Chat SDK & React UI Kit',
  favicon: 'img/favicon.ico',

  // Set the production url of your site here
  url: 'https://docs.ermis.network',
  // Set the /<baseUrl>/ pathname under which your site is served
  baseUrl: '/',

  onBrokenLinks: 'ignore',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Ermis Chat',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'coreSdkSidebar',
          position: 'left',
          label: 'Core SDK',
        },
        {
          type: 'docSidebar',
          sidebarId: 'reactSdkSidebar',
          position: 'left',
          label: 'React UI Kit',
        },
        {
          href: 'https://github.com/ermisnetwork/ermis-chat-monorepo',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Core SDK',
              to: '/docs/core-sdk/intro',
            },
            {
              label: 'React UI Kit',
              to: '/docs/react/intro',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Ermis Network. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
