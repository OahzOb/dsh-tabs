/**
 * Render `assets/icon.svg` to PNGs at the exact sizes the platforms ask for, through
 * Chromium itself.
 *
 * Why not an image library: the icon has to be rasterised at 16, 20, 24, 32, 40, 48,
 * 64, 128 and 256 pixels, and a downscale from one large render is not the same
 * picture as a small render. The whole question at 16 pixels is whether the shape
 * survives, and only a real 16-pixel rasterisation answers it. Chromium is also the
 * engine both clients draw through — the desktop one *is* Chromium — so it is the
 * renderer whose answer is worth having. It is already here: Electron is this
 * application's dependency.
 *
 * Usage, from the repository root:
 *
 *   .\node_modules\electron\dist\electron.exe tools/render-icon.cjs assets/icon.svg .tmp/icon 512,256,128,64,48,40,32,24,20,16
 *
 * Sizes may also be `WxH`, for a drawing that is not square.
 */
const { app, BrowserWindow } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, extname, join, resolve } = require('node:path')

const args = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
const [source, outDir, sizes] = args
if (source === undefined || outDir === undefined || sizes === undefined) {
	console.error('usage: electron render-icon.cjs <source.svg> <out-dir> <size>[,<size>...]')
	process.exit(2)
}

const svgPath = resolve(source)
const markup = readFileSync(svgPath, 'utf8').replace(/<\?xml[^>]*\?>/u, '')
const name = basename(svgPath, extname(svgPath))
const wanted = sizes
	.split(',')
	.map((value) => value.trim())
	.filter((value) => value !== '')
	.map((value) => {
		const [width, height] = value.split('x').map((part) => Number(part))
		return { width, height: height ?? width }
	})
	.filter((size) => Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0)
if (wanted.length === 0) {
	console.error('no sizes to render')
	process.exit(2)
}

/**
 * The page: the drawing inline, in a box whose size is set per rung of the ladder,
 * on nothing.
 *
 * The box is what makes a small render small. Resizing the *window* down to 16 pixels
 * does not work — Windows enforces a minimum window width, and a request for 16 comes
 * back as a 32x39 capture, with 32 and 16 coming back identical. So the window stays
 * large, the drawing is laid out at the size being rendered, and that rectangle is
 * what gets captured.
 */
const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
	html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
	#box { position: absolute; left: 0; top: 0; width: 256px; height: 256px; }
	#box svg { display: block; width: 100%; height: 100%; }
</style></head><body><div id="box">${markup}</div></body></html>`

void app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: false,
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		width: 512,
		height: 512,
		webPreferences: { offscreen: false, backgroundThrottling: false }
	})

	await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
	mkdirSync(resolve(outDir), { recursive: true })

	for (const size of wanted) {
		await window.webContents.executeJavaScript(
			`document.getElementById('box').style.width = '${String(size.width)}px';
			 document.getElementById('box').style.height = '${String(size.height)}px';
			 new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`
		)
		const image = await window.webContents.capturePage({ x: 0, y: 0, width: size.width, height: size.height })
		const png = image.toPNG()
		const suffix = size.width === size.height ? String(size.width) : `${String(size.width)}x${String(size.height)}`
		const path = join(resolve(outDir), `${name}-${suffix}.png`)
		writeFileSync(path, png)
		console.log(`${path}  ${String(image.getSize().width)}x${String(image.getSize().height)}  ${String(png.length)} bytes`)
	}

	app.quit()
})
