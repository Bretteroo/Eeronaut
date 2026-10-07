import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/* THIRD-PARTY-NOTICES.txt, beside the built app and linked from About.

   The libraries bundled into the interface (React, React Router and what
   they bring with them) are MIT-licensed, and MIT asks that the copyright
   and permission notice travel with every copy. Minified into the bundle,
   they did not. This finds every package a chunk actually contains, rather
   than every package installed, and writes each one's license text; then
   the files in licenses/, for icons copied into the source rather than
   installed. Tailwind and Vite are added by hand: Tailwind contributes CSS,
   which no chunk lists, and Vite a small loader of its own that arrives as
   a virtual module rather than from a package. */
function thirdPartyNotices(): Plugin {
  const PKG = /^(.*?[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/
  return {
    name: 'third-party-notices',
    apply: 'build',
    generateBundle(_, bundle) {
      const dirs = new Set<string>(
        ['tailwindcss', 'vite'].map((p) => resolve('node_modules', p)))
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue
        for (const id of Object.keys(out.modules)) {
          const hit = id.replace(/^\0/, '').match(PKG)
          if (hit) dirs.add(hit[1])
        }
      }
      const parts: string[] = []
      for (const dir of [...dirs].sort()) {
        const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
        const text = file ? readFileSync(join(dir, file), 'utf8').trim()
                          : `License: ${meta.license ?? 'see the package'}`
        parts.push(`${meta.name} ${meta.version} (${meta.license ?? 'unknown'})\n\n${text}`)
      }
      const extra = resolve('licenses')
      if (existsSync(extra)) {
        for (const f of readdirSync(extra).sort()) {
          parts.push(readFileSync(join(extra, f), 'utf8').trim())
        }
      }
      const rule = `\n\n${'='.repeat(78)}\n\n`
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD-PARTY-NOTICES.txt',
        source: 'Eeronaut is licensed under AGPL-3.0-only. It includes the '
          + 'following third-party\nsoftware, each under its own license.'
          + rule + parts.join(rule) + '\n',
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), thirdPartyNotices()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8099', changeOrigin: true } },
  },
  build: { outDir: '../backend/eeronaut/static', emptyOutDir: true },
})
