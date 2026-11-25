// 测试引导：先注册别名/扩展名解析钩子，再导入测试文件
import { register } from 'node:module'

const loaderUrl = new URL('./alias-loader.mjs', import.meta.url).href
const testUrl = new URL('./incremental.test.mjs', import.meta.url).href
register(loaderUrl, import.meta.url)
await import(testUrl)
