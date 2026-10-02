/**
 * Builds the browser test drive into demo-dist/: the real staff screens, gate display and
 * simulator, plus the access system compiled for the browser (sql.js in place of bun:sqlite).
 *   bun run demo:build
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const pub = join(root, 'public')
const out = join(root, 'demo-dist')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const shims: Record<string, string> = {
  'bun:sqlite': join(root, 'src/demo/sqlite-shim.ts'),
  'node:crypto': join(root, 'src/demo/crypto-shim.ts'),
  'node:fs': join(root, 'src/demo/node-shims.ts'),
  'node:path': join(root, 'src/demo/node-shims.ts'),
}
const result = await Bun.build({
  entrypoints: [join(root, 'src/demo/engine.ts')],
  target: 'browser',
  format: 'iife',
  minify: true,
  plugins: [
    {
      name: 'browser-shims',
      setup(build) {
        build.onResolve({ filter: /^(bun:sqlite|node:crypto|node:fs|node:path)$/ }, args => ({ path: shims[args.path]! }))
      },
    },
  ],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
writeFileSync(join(out, 'engine.js'), await result.outputs[0]!.text())

// Fonts go inline: the preview page only loads fonts from data: URLs or Google Fonts.
const fontData = (file: string) => `url('data:font/woff2;base64,${readFileSync(join(pub, 'fonts', file)).toString('base64')}')`
const inlineFonts = (text: string) =>
  text.replace(/url\('fonts\/([a-z-]+\.woff2)'\)/g, (_, file: string) => fontData(file))
const bridge = '<script src="demo-bridge.js"></script>'
const withBridge = (html: string) => html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  ${bridge}`)

for (const f of ['lib.js', 'app.js', 'sim.js', 'gate.js']) cpSync(join(pub, f), join(out, f))
cpSync(join(pub, 'brand'), join(out, 'brand'), { recursive: true })
mkdirSync(join(out, 'fonts'))
cpSync(join(pub, 'fonts', 'LICENSE-OFL.txt'), join(out, 'fonts', 'LICENSE-OFL.txt'))
writeFileSync(join(out, 'style.css'), inlineFonts(readFileSync(join(pub, 'style.css'), 'utf8')))
writeFileSync(join(out, 'staff.html'), withBridge(readFileSync(join(pub, 'index.html'), 'utf8')))
writeFileSync(join(out, 'gate.html'), withBridge(inlineFonts(readFileSync(join(pub, 'gate.html'), 'utf8'))))
// The test drive has its own tabs, so the simulator's "open in new tab" links are hidden.
writeFileSync(
  join(out, 'sim.html'),
  withBridge(readFileSync(join(pub, 'sim.html'), 'utf8')).replace('</head>', '  <style>#sim-links { display: none; }</style>\n</head>'),
)
cpSync(join(root, 'src/demo/bridge.js'), join(out, 'demo-bridge.js'))
cpSync(join(root, 'node_modules/sql.js/dist/sql-asm.js'), join(out, 'sql-asm.js'))
writeFileSync(join(out, 'index.html'), inlineFonts(readFileSync(join(root, 'src/demo/shell.html'), 'utf8')))

console.log(`Test drive built in ${out}`)
