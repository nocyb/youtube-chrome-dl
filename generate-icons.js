const fs = require('fs');
const zlib = require('zlib');

function createPNG(size) {
  const width = size, height = size;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowSize = 1 + width * 3;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0;
    for (let x = 0; x < width; x++) {
      const offset = y * rowSize + 1 + x * 3;
      const cx = width / 2, cy = height / 2;
      const r = Math.min(width, height) * 0.35;
      const tx = (x - cx + r * 0.3) / r;
      const ty = (y - cy) / r;
      const inTriangle = tx >= -0.2 && tx <= 0.6 && Math.abs(ty) < (0.6 - tx) * 0.8;

      if (inTriangle) {
        rawData[offset] = 255;
        rawData[offset + 1] = 255;
        rawData[offset + 2] = 255;
      } else {
        rawData[offset] = 255;
        rawData[offset + 1] = 68;
        rawData[offset + 2] = 68;
      }
    }
  }

  const compressed = zlib.deflateSync(rawData);

  function crc(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) {
        c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
      }
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crc32 = crc(Buffer.concat([typeB, data]));
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crc32 >>> 0);
    return Buffer.concat([len, typeB, data, crcB]);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

[16, 48, 128].forEach(size => {
  const png = createPNG(size);
  fs.writeFileSync(__dirname + '/icons/icon' + size + '.png', png);
  console.log('Created icon' + size + '.png (' + png.length + ' bytes)');
});

console.log('Done.');
