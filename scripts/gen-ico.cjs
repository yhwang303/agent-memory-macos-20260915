const sharp = require('sharp');
const fs = require('fs');

async function createIco(inputPng, outputIco) {
  const sizes = [16, 32, 48, 256];
  const images = [];

  for (const size of sizes) {
    const rgba = await sharp(inputPng)
      .resize(size, size)
      .ensureAlpha()
      .raw()
      .toBuffer();
    
    if (size <= 48) {
      // BMP format for small sizes
      const bihSize = 40;
      const rowSize = size * 4; // BGRA
      const pixelDataSize = rowSize * size;
      const andMaskRowSize = Math.ceil(size / 32) * 4;
      const andMaskSize = andMaskRowSize * size;

      const bih = Buffer.alloc(bihSize);
      bih.writeInt32LE(bihSize, 0);
      bih.writeInt32LE(size, 4);
      bih.writeInt32LE(size * 2, 8); // height * 2 for ICO
      bih.writeUInt16LE(1, 12);      // planes
      bih.writeUInt16LE(32, 14);     // bpp
      bih.writeUInt32LE(0, 16);      // compression
      bih.writeUInt32LE(pixelDataSize + andMaskSize, 20);

      // Convert RGBA top-down to BGRA bottom-up
      const pixelData = Buffer.alloc(pixelDataSize);
      for (let y = 0; y < size; y++) {
        const srcRow = y;
        const dstRow = size - 1 - y;
        for (let x = 0; x < size; x++) {
          const si = (srcRow * size + x) * 4;
          const di = (dstRow * size + x) * 4;
          pixelData[di + 0] = rgba[si + 2]; // B
          pixelData[di + 1] = rgba[si + 1]; // G
          pixelData[di + 2] = rgba[si + 0]; // R
          pixelData[di + 3] = rgba[si + 3]; // A
        }
      }

      const andMask = Buffer.alloc(andMaskSize, 0);
      const imgData = Buffer.concat([bih, pixelData, andMask]);
      images.push({ size, data: imgData, isPng: false });
    } else {
      // PNG for 256x256
      const pngBuf = await sharp(inputPng)
        .resize(size, size)
        .png()
        .toBuffer();
      images.push({ size, data: pngBuf, isPng: true });
    }
  }

  // ICO header
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);    // reserved
  header.writeUInt16LE(1, 2);    // type: ICO
  header.writeUInt16LE(images.length, 4);

  // Directory entries
  const dirSize = images.length * 16;
  let dataOffset = 6 + dirSize;
  const entries = Buffer.alloc(dirSize);

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const off = i * 16;
    entries[off + 0] = img.size >= 256 ? 0 : img.size;  // width
    entries[off + 1] = img.size >= 256 ? 0 : img.size;  // height
    entries[off + 2] = 0;  // palette
    entries[off + 3] = 0;  // reserved
    entries.writeUInt16LE(1, off + 4);   // planes
    entries.writeUInt16LE(32, off + 6);  // bpp
    entries.writeUInt32LE(img.data.length, off + 8);
    entries.writeUInt32LE(dataOffset, off + 12);
    dataOffset += img.data.length;
  }

  const ico = Buffer.concat([header, entries, ...images.map(i => i.data)]);
  fs.writeFileSync(outputIco, ico);
  console.log(`${outputIco}: ${sizes.join(',')} sizes, ${ico.length} bytes`);
}

createIco('desktop/src/assets/icon.png', 'desktop/src/assets/icon.ico');
