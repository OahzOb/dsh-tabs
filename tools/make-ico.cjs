/**
 * Pack rendered PNGs into a Windows `.ico`.
 *
 * The container is four fields of header and then one 16-byte directory entry per
 * image; the images themselves are the PNGs, byte for byte. That is the whole format
 * for what this needs — every size from 16 to 256 is carried at its own resolution,
 * which is the point of an icon file.
 *
 * **The entries are PNG-compressed, not DIB.** Windows has accepted PNG entries since
 * Vista, and every shell that will draw this icon — the taskbar, Explorer, the Start
 * menu — is well past that. A DIB entry would be larger by an order of magnitude and
 * would need a PNG decoder in this file to produce, which Node does not have. If a
 * tool from before 2006 ever needs to read this file, that is the trade to revisit.
 *
 * Usage:
 *
 *   node tools/make-ico.cjs assets/icon.ico assets/icon-512.png assets/icon-256.png ...
 */
const { readFileSync, writeFileSync } = require('node:fs')

const [target, ...sources] = process.argv.slice(2)
if (target === undefined || sources.length === 0) {
	console.error('usage: node make-ico.cjs <out.ico> <in.png> [in.png ...]')
	process.exit(2)
}

/**
 * A PNG's own dimensions, read out of its IHDR.
 *
 * The directory entry needs width and height, and reading them here is cheaper than
 * being told: a caller who passes the wrong size gets an icon whose entries disagree
 * with their images, which the shell draws as garbage.
 *
 * @param buffer - the whole PNG file.
 * @returns the width and height in pixels.
 */
function pngSize(buffer) {
	if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
	// IHDR is the first chunk: 8 bytes of signature, 4 of length, 4 of type, then the
	// two dimensions.
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const images = sources
	.map((source) => {
		const data = readFileSync(source)
		const { width, height } = pngSize(data)
		return { source, data, width, height }
	})
	// Largest entry first would be the more natural order to read; Windows does not
	// care, but a stable one keeps the diff of a regenerated file meaningful.
	.sort((left, right) => left.width - right.width)

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // 1 = icon
header.writeUInt16LE(images.length, 4)

const directory = Buffer.alloc(16 * images.length)
let offset = header.length + directory.length
images.forEach((image, index) => {
	const entry = index * 16
	// 256 is written as 0: the field is one byte.
	directory.writeUInt8(image.width >= 256 ? 0 : image.width, entry)
	directory.writeUInt8(image.height >= 256 ? 0 : image.height, entry + 1)
	directory.writeUInt8(0, entry + 2) // palette colours
	directory.writeUInt8(0, entry + 3) // reserved
	directory.writeUInt16LE(1, entry + 4) // colour planes
	directory.writeUInt16LE(32, entry + 6) // bits per pixel
	directory.writeUInt32LE(image.data.length, entry + 8)
	directory.writeUInt32LE(offset, entry + 12)
	offset += image.data.length
})

writeFileSync(target, Buffer.concat([header, directory, ...images.map((image) => image.data)]))
console.log(`${target}  ${String(images.length)} sizes: ${images.map((image) => String(image.width)).join(', ')}`)
