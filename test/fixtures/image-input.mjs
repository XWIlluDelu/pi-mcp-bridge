import { crc32, deflateSync } from 'node:zlib';
import { randomBytes, createHash } from 'node:crypto';

// A real RGBA PNG, including CRCs. Random pixels make the large transport case
// incompressible; no external image files, image tools or network are required.
export function pngImage(width = 2, height = 2) {
  const chunk = (type, data) => {
    const kind = Buffer.from(type),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([size, kind, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row++)
    randomBytes(width * 4).copy(pixels, row * (1 + width * 4) + 1);
  const bytes = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') };
}
export function imageEvidence(image) {
  const bytes = Buffer.from(image.data, 'base64');
  return {
    mimeType: image.mimeType,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
