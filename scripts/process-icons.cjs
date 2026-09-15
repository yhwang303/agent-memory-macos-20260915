const sharp = require('sharp');
const path = require('path');

const files = [
  { src: 'source-data/icon_green.png', dst: 'desktop/src/assets/icon-green.png', trayDst: 'desktop/src/assets/icon-green-tray.png', thresh: 212 },
  { src: 'source-data/icon_red.png', dst: 'desktop/src/assets/icon-red.png', trayDst: 'desktop/src/assets/icon-red-tray.png', thresh: 212 },
  { src: 'source-data/icon_orange.png', dst: 'desktop/src/assets/icon-yellow.png', trayDst: 'desktop/src/assets/icon-yellow-tray.png', thresh: 212 },
  { src: 'source-data/icon_grey.png', dst: 'desktop/src/assets/icon-gray.png', trayDst: 'desktop/src/assets/icon-gray-tray.png', thresh: 208 },
];

const MAC_TRAY_ICON_SIZE = 22;

async function processIcon(src, dst, thresh, trayDst) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const visited = new Uint8Array(w * h);

  function floodFill(startX, startY) {
    const stack = [[startX, startY]];
    while (stack.length > 0) {
      const [x, y] = stack.pop();
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const pi = y * w + x;
      if (visited[pi]) continue;
      const idx = pi * 4;
      const avg = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (avg <= thresh) continue;
      visited[pi] = 1;
      data[idx + 3] = 0;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  for (let x = 0; x < w; x++) { floodFill(x, 0); floodFill(x, h - 1); }
  for (let y = 0; y < h; y++) { floodFill(0, y); floodFill(w - 1, y); }

  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const pad = 8;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const side = Math.max(cropW, cropH);
  const offsetX = Math.floor((side - cropW) / 2);
  const offsetY = Math.floor((side - cropH) / 2);

  const image = sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .extend({
      top: offsetY, bottom: side - cropH - offsetY,
      left: offsetX, right: side - cropW - offsetX,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });

  await image
    .clone()
    .png()
    .toFile(dst);

  if (trayDst) {
    await sharp(dst)
      .resize(MAC_TRAY_ICON_SIZE, MAC_TRAY_ICON_SIZE)
      .png()
      .toFile(trayDst);
  }

  console.log(`${path.basename(src)} -> ${path.basename(dst)} [${side}x${side}]`);
}

(async () => {
  for (const f of files) {
    await processIcon(f.src, f.dst, f.thresh, f.trayDst);
  }
  await processIcon('source-data/icon_green.png', 'desktop/src/assets/icon.png', 212);
  console.log('Done!');
})();
