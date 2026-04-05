import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 兼容不同云崽版本的 logger
const log = global.logger || console

log.info('━━━━━━━━━━━━━━━━━━━━')
log.info('课程表插件 v1.0.0')
log.info('━━━━━━━━━━━━━━━━━━━━')

// 检查依赖
let missingDeps = []

try {
  await import('axios')
} catch {
  missingDeps.push('axios')
}

try {
  await import('node-ical')
} catch {
  missingDeps.push('node-ical')
}

if (missingDeps.length > 0) {
  log.error(`[课程表] 缺少依赖: ${missingDeps.join(', ')}`)
  log.error('[课程表] 请在云崽根目录执行: pnpm install axios node-ical -w')
}

// 加载应用
const appsPath = join(__dirname, 'apps')

if (!fs.existsSync(appsPath)) {
  log.error('[课程表] apps 目录不存在')
  throw new Error('apps directory not found')
}

const files = fs.readdirSync(appsPath).filter(file => file.endsWith('.js'))

if (files.length === 0) {
  log.warn('[课程表] apps 目录为空')
}

let apps = {}
let loadedCount = 0

for (const file of files) {
  try {
    const filePath = `file://${join(appsPath, file)}`
    const app = await import(filePath)
    
    // 提取所有导出的类
    for (const key in app) {
      if (key !== 'default' && typeof app[key] === 'function') {
        apps[key] = app[key]
        loadedCount++
        log.info(`[课程表] ✓ ${file} -> ${key}`)
      }
    }
  } catch (err) {
    log.error(`[课程表] ✗ ${file} 加载失败`)
    log.error(err)
  }
}

if (loadedCount > 0) {
  log.info(`[课程表] 成功加载 ${loadedCount} 个应用`)
} else {
  log.error('[课程表] 没有加载任何应用')
}

log.info('━━━━━━━━━━━━━━━━━━━━')

export { apps }
