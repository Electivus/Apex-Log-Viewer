import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = path.join(process.cwd(), 'apex-log-viewer');
const mediaDir = path.join(root, 'media');
const svgPath = path.join(mediaDir, 'icon.svg');
const png128Path = path.join(mediaDir, 'icon.png');
const png256Path = path.join(mediaDir, 'icon-256.png');

async function main() {
  if (!fs.existsSync(svgPath)) {
    console.error(`SVG not found: ${svgPath}`);
    process.exit(1);
  }
  await sharp(svgPath, { density: 384 }) // higher density for crisp raster
    .png({ compressionLevel: 9 })
    .resize(128, 128, { fit: 'contain' })
    .toFile(png128Path);

  await sharp(svgPath, { density: 512 })
    .png({ compressionLevel: 9 })
    .resize(256, 256, { fit: 'contain' })
    .toFile(png256Path);

  console.log('Generated:', path.relative(root, png128Path), 'and', path.relative(root, png256Path));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

