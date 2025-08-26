import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = path.join(process.cwd(), 'apex-log-viewer');
const media = path.join(root, 'media');

async function ensure(svg, outPng, width, height, density = 384) {
  if (!fs.existsSync(svg)) throw new Error(`SVG not found: ${svg}`);
  await sharp(svg, { density })
    .png({ compressionLevel: 9 })
    .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toFile(outPng);
  console.log('Generated', path.relative(root, outPng));
}

async function main() {
  // Banner
  await ensure(path.join(media, 'banner.svg'), path.join(media, 'banner.png'), 1600, 800, 512);

  // Electivus brand
  const brandDir = path.join(media, 'brand');
  await ensure(path.join(brandDir, 'electivus-mark.svg'), path.join(brandDir, 'electivus-mark-512.png'), 512, 512, 512);
  await ensure(path.join(brandDir, 'electivus-logo.svg'), path.join(brandDir, 'electivus-logo-1024.png'), 1024, 256, 512);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

