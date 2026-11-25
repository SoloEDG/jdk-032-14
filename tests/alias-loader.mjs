// 测试专用 ESM 加载器：
//  1. 把 "@/..." 别名解析到 src 目录
//  2. 支持 TS 项目里无扩展名的相对导入（./model/useSimulation → .ts / index.ts）
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { existsSync } from 'node:fs'

const srcRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function tryCandidate(candidate) {
  return existsSync(candidate) ? { url: pathToFileURL(candidate).href, shortCircuit: true } : null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const rel = specifier.slice(2)
    const hit = tryCandidate(resolvePath(srcRoot, `${rel}.ts`))
      ?? tryCandidate(resolvePath(srcRoot, rel, 'index.ts'))
    if (hit) return hit
    throw new Error(`无法解析测试导入: ${specifier}`)
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const base = fileURLToPath(context.parentURL)
    const target = resolvePath(dirname(base), specifier)
    const hit = tryCandidate(`${target}.ts`)
      ?? tryCandidate(resolvePath(target, 'index.ts'))
      ?? tryCandidate(target)
    if (hit) return hit
  }
  return nextResolve(specifier, context)
}
