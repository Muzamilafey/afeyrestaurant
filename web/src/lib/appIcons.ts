import { api } from './api';

/**
 * App icons from the business logo. Browsers and phones need square PNGs at fixed sizes for the tab icon, the home
 * screen and the installed app, so they are drawn here from whatever logo was uploaded (JPEG/PNG/WebP, any shape)
 * and uploaded like any other image.
 */
export interface AppIcons { icon192: string; icon512: string; maskable512: string; source: string }

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The logo could not be loaded to make app icons'));
    img.src = url;
  });
}

/** Square PNG with the logo fitted inside `scale` of the canvas on a white background (rounded unless full-bleed). */
function draw(img: HTMLImageElement, size: number, scale: number, rounded: boolean) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  if (rounded) {
    const r = size * 0.22;
    g.beginPath();
    g.moveTo(r, 0);
    g.arcTo(size, 0, size, size, r);
    g.arcTo(size, size, 0, size, r);
    g.arcTo(0, size, 0, 0, r);
    g.arcTo(0, 0, size, 0, r);
    g.closePath();
    g.fill();
  } else g.fillRect(0, 0, size, size);
  const box = size * scale;
  const k = Math.min(box / img.naturalWidth, box / img.naturalHeight);
  const w = img.naturalWidth * k;
  const h = img.naturalHeight * k;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the app icon'))), 'image/png'));
}

async function upload(blob: Blob, name: string) {
  const fd = new FormData();
  fd.append('file', new File([blob], name, { type: 'image/png' }));
  return (await api<{ url: string }>('/menu/uploads/image', { method: 'POST', body: fd })).url;
}

/** Generate and upload the 192px, 512px and maskable (Android adaptive) icons for a logo. */
export async function makeAppIcons(logoUrl: string): Promise<AppIcons> {
  const img = await loadImage(logoUrl);
  const [a, b, m] = await Promise.all([draw(img, 192, 0.84, true), draw(img, 512, 0.84, true), draw(img, 512, 0.56, false)]);
  const [icon192, icon512, maskable512] = await Promise.all([upload(a, 'icon-192.png'), upload(b, 'icon-512.png'), upload(m, 'icon-maskable-512.png')]);
  return { icon192, icon512, maskable512, source: logoUrl };
}

/** Point the browser tab icon, the iOS home-screen icon and the window title at the business. */
export function applyDocumentBranding(b: { name?: string | null; logoUrl?: string | null; icons?: AppIcons | null; primaryColor?: string | null }) {
  const set = (rel: string, href: string, type?: string) => {
    let l = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
    if (!l) {
      l = document.createElement('link');
      l.rel = rel;
      document.head.appendChild(l);
    }
    if (type) l.type = type;
    else l.removeAttribute('type');
    l.href = href;
  };
  const tab = b.icons?.icon192 ?? b.logoUrl;
  set('icon', tab ?? '/favicon.svg', tab ? undefined : 'image/svg+xml');
  set('apple-touch-icon', b.icons?.icon512 ?? b.logoUrl ?? '/apple-touch-icon.png');
  const name = b.name && b.name !== 'Chili POS' ? `${b.name} · Chili POS` : 'Chili POS';
  if (document.title !== name) document.title = name;
  const meta = document.head.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  if (meta && b.name) meta.content = b.name;
}
