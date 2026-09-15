const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const assetsDir = path.join(__dirname, '..', 'src', 'assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

function createPNG(width, height, r, g, b) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = createChunk('IHDR', ihdrData);

  const rawData = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const offset = y * (1 + width * 3);
    rawData[offset] = 0;
    for (let x = 0; x < width; x++) {
      const px = offset + 1 + x * 3;
      rawData[px] = r;
      rawData[px + 1] = g;
      rawData[px + 2] = b;
    }
  }
  const compressed = zlib.deflateSync(rawData);
  const idat = createChunk('IDAT', compressed);

  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const icons = {
  'icon-green.png': [76, 175, 80],
  'icon-yellow.png': [255, 193, 7],
  'icon-red.png': [244, 67, 54],
  'icon-gray.png': [158, 158, 158],
};

for (const [name, [r, g, b]] of Object.entries(icons)) {
  const png = createPNG(16, 16, r, g, b);
  fs.writeFileSync(path.join(assetsDir, name), png);
  console.log(`Created ${name}`);
}

const appIcon = createPNG(256, 256, 76, 175, 80);
fs.writeFileSync(path.join(assetsDir, 'icon.png'), appIcon);
console.log('Created icon.png (256x256 placeholder)');

function createBMP(width, height, r, g, b) {
  const rowSize = Math.ceil((width * 32) / 32) * 4;
  const pixelDataSize = rowSize * height;
  const bmpData = Buffer.alloc(pixelDataSize);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * rowSize + x * 4;
      bmpData[offset] = b;
      bmpData[offset + 1] = g;
      bmpData[offset + 2] = r;
      bmpData[offset + 3] = 255;
    }
  }
  return bmpData;
}

function createICO(sizes, r, g, b) {
  const numImages = sizes.length;
  const headerSize = 6 + numImages * 16;
  const images = [];
  let dataOffset = headerSize;

  for (const size of sizes) {
    const bmpPixels = createBMP(size, size, r, g, b);
    const bihSize = 40;
    const bih = Buffer.alloc(bihSize);
    bih.writeInt32LE(bihSize, 0);
    bih.writeInt32LE(size, 4);
    bih.writeInt32LE(size * 2, 8);
    bih.writeUInt16LE(1, 12);
    bih.writeUInt16LE(32, 14);
    bih.writeUInt32LE(0, 16);
    bih.writeUInt32LE(bmpPixels.length, 20);

    const imgData = Buffer.concat([bih, bmpPixels]);
    images.push({ size, data: imgData, offset: dataOffset });
    dataOffset += imgData.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(numImages, 4);

  const entries = Buffer.alloc(numImages * 16);
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const off = i * 16;
    entries[off] = img.size >= 256 ? 0 : img.size;
    entries[off + 1] = img.size >= 256 ? 0 : img.size;
    entries[off + 2] = 0;
    entries[off + 3] = 0;
    entries.writeUInt16LE(1, off + 4);
    entries.writeUInt16LE(32, off + 6);
    entries.writeUInt32LE(img.data.length, off + 8);
    entries.writeUInt32LE(img.offset, off + 12);
  }

  return Buffer.concat([header, entries, ...images.map(i => i.data)]);
}

const ico = createICO([16, 32, 48, 256], 76, 175, 80);
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);
console.log('Created icon.ico (multi-size)');
