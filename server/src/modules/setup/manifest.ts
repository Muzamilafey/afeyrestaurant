import { Router } from 'express';
import { getBusiness } from '../../services/setup';

/**
 * Web app manifest for installing Chili POS as an app (PWA). Served by the API rather than baked into the build so
 * the installed app carries the business name and brand colour chosen in Settings. Icons stay the bundled PNGs —
 * install prompts need fixed-size 192/512 PNGs, which an arbitrary uploaded logo cannot guarantee.
 */
export const manifestRouter = Router();
manifestRouter.get('/manifest.webmanifest', async (_req, res) => {
  const b = await getBusiness().catch(() => null); // never block installing because the DB is briefly unavailable
  const name = b?.name ?? 'Chili POS';
  const theme = /^#[0-9a-fA-F]{6}$/.test(b?.branding?.primaryColor ?? '') ? b!.branding!.primaryColor! : '#07963C';
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').json({
    id: '/',
    name,
    short_name: name.length <= 12 ? name : name.split(/\s+/)[0].slice(0, 12),
    description: `${name} — restaurant & bar point of sale`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone'],
    orientation: 'any',
    theme_color: theme,
    background_color: '#F3F5F4',
    categories: ['business', 'food', 'productivity'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'New order', short_name: 'POS', url: '/pos', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: 'Orders', url: '/orders', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: 'Kitchen display', short_name: 'Kitchen', url: '/kitchen', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    ],
  });
});
