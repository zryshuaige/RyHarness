/**
 * 主进程的两道权限闸：交给系统打开的路径、浏览器权限的放行名单。
 *
 * 这两条都是"少一道就出事"的地方：
 *
 * - `shell.openPath` 对 .exe / .lnk / .bat 就是**直接执行**，而入参是 agent 用
 *   file_produce 写出来的路径（内容由模型决定，模型可能被提示注入影响）；
 * - Electron 默认**自动批准所有权限请求**，不装 handler 就等于摄像头、麦克风、
 *   剪贴板读、串口全都无声放开。
 *
 * @module apps/desktop/tests/main-process-guards
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateLegacyDataDir } from '../electron/data-dir.ts'
import {
  allowedPermission,
  canOpenPath,
  dotEnvCandidates,
  envTokenAllowed,
  envValue,
  isInsideRoot,
} from '../electron/security.ts'

const ROOT = join('C:\\', 'ryharness-data', 'workspace')

describe('能交给系统打开的路径', () => {
  it('工作区里的普通文件放行', () => {
    expect(canOpenPath(ROOT, join(ROOT, 'artifacts', '周报.md'))).toBe(true)
    expect(canOpenPath(ROOT, join(ROOT, 'artifacts', 'data.xlsx'))).toBe(true)
  })

  it('工作区目录本身放行（「打开工作区目录」走的就是这条）', () => {
    expect(canOpenPath(ROOT, ROOT)).toBe(true)
  })

  it('工作区之外一律拦下', () => {
    expect(canOpenPath(ROOT, 'C:\\Windows\\System32\\cmd.exe')).toBe(false)
    expect(canOpenPath(ROOT, 'C:\\Users\\me\\Downloads\\setup.exe')).toBe(false)
  })

  it('只是前缀相同的兄弟目录不算在工作区内', () => {
    // C:\ryharness-data\workspace-evil 与 C:\ryharness-data\workspace 前缀相同但毫无关系。
    const sibling = 'C:\\ryharness-data\\workspace-evil\\payload.exe'
    expect(isInsideRoot(ROOT, sibling)).toBe(false)
    expect(canOpenPath(ROOT, sibling)).toBe(false)
  })

  it('可执行扩展名一律拦下（openPath 对它们就是执行）', () => {
    for (const name of ['a.exe', 'a.lnk', 'a.bat', 'a.cmd', 'a.msi', 'a.ps1', 'a.vbs', 'a.jar', 'a.hta', 'a.scr']) {
      expect(canOpenPath(ROOT, join(ROOT, 'artifacts', name))).toBe(false)
    }
    // 大写扩展名同样拦下。
    expect(canOpenPath(ROOT, join(ROOT, 'artifacts', 'A.EXE'))).toBe(false)
  })

  it('相对路径与非字符串都拦下', () => {
    expect(canOpenPath(ROOT, 'artifacts/周报.md')).toBe(false)
    expect(canOpenPath(ROOT, '')).toBe(false)
    expect(canOpenPath(ROOT, undefined)).toBe(false)
    expect(canOpenPath(ROOT, 42)).toBe(false)
  })
})

describe('浏览器权限', () => {
  it('只放行往剪贴板写', () => {
    expect(allowedPermission('clipboard-write')).toBe(true)
    expect(allowedPermission('clipboard-sanitized-write')).toBe(true)
  })

  it('摄像头、麦克风、剪贴板读、通知、串口一律拒绝', () => {
    for (const permission of ['media', 'clipboard-read', 'notifications', 'serial', 'pointerLock', 'midi', 'hid']) {
      expect(allowedPermission(permission)).toBe(false)
    }
  })
})

describe('API token 的环境变量旁路', () => {
  it('只在 CI 或截图模式下认环境变量', () => {
    expect(envTokenAllowed({ CI: 'true' })).toBe(true)
    expect(envTokenAllowed({ RYHARNESS_CAPTURE: '1' })).toBe(true)
  })

  it('普通用户启动不认这个环境变量', () => {
    expect(envTokenAllowed({})).toBe(false)
    expect(envTokenAllowed({ CI: 'false' })).toBe(false)
    expect(envTokenAllowed({ RYHARNESS_CAPTURE: '0' })).toBe(false)
  })
})

describe('.env 的读取位置', () => {
  const base = {
    envFile: 'D:\\explicit\\.env',
    userData: 'C:\\Users\\me\\AppData\\Roaming\\RyHarness',
    appPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\RyHarness\\resources\\app.asar',
    cwd: 'C:\\Users\\me\\Downloads',
  }

  it('生产态只认显式指定与 userData 两处', () => {
    const candidates = dotEnvCandidates({ ...base, packaged: true })
    expect(candidates).toEqual(['D:\\explicit\\.env', 'C:\\Users\\me\\AppData\\Roaming\\RyHarness\\.env'])
  })

  it('生产态不碰安装目录与当前目录', () => {
    const candidates = dotEnvCandidates({ ...base, packaged: true })
    expect(
      candidates.some((candidate) => {
        return candidate.includes('Programs')
      }),
    ).toBe(false)
    expect(
      candidates.some((candidate) => {
        return candidate.includes('Downloads')
      }),
    ).toBe(false)
  })

  it('开发态多给仓库根与当前目录', () => {
    const candidates = dotEnvCandidates({ ...base, packaged: false })
    expect(candidates.length).toBeGreaterThan(2)
    expect(
      candidates.some((candidate) => {
        return candidate.includes('Downloads')
      }),
    ).toBe(true)
  })
})

describe('主进程源码里的接线', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')

  it('装了权限请求与权限检查两个 handler', () => {
    expect(main).toContain('setPermissionRequestHandler')
    expect(main).toContain('setPermissionCheckHandler')
  })

  it('open-path 先校验来源再校验路径', () => {
    expect(main).toContain('isTrustedSender(event)')
    expect(main).toContain('canOpenPath(workspaceRoot, targetPath)')
  })

  it('标题栏主题改成推，不再每 400ms 问渲染层一次', () => {
    // 轮询版：setInterval(sync, 400) —— 一次 executeJavaScript 就是一个跨进程往返，
    // 常年占着渲染层的主线程。
    expect(main).not.toContain('setInterval(sync, 400)')
    expect(main).toContain("ipcMain.on('ryharness:theme'")
  })
})

describe('主题这条通道', () => {
  it('preload 暴露的是「说一声」而不是 ipcRenderer 本身', () => {
    const preload = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8')
    expect(preload).toContain('setTheme')
    expect(preload).toContain("ipcRenderer.send('ryharness:theme'")
    // 桥面刻意小：不能把 ipcRenderer 交出去。
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/)
  })

  it('渲染层切主题时会把新主题推给主进程', () => {
    const app = readFileSync(new URL('../renderer/src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('reportTheme(theme)')
  })
})

describe('改名那天的兼容', () => {
  it('环境变量：新名优先，旧名仍然认', () => {
    expect(envValue({ RYHARNESS_PORT: '1', RYAGENT_PORT: '2' }, 'PORT')).toBe('1')
    expect(envValue({ RYAGENT_PORT: '2' }, 'PORT')).toBe('2')
    expect(envValue({}, 'PORT')).toBeUndefined()
  })

  it('老数据目录会被搬到新位置，数据库也跟着改名', () => {
    const moved: [string, string][] = []
    const renamed: [string, string][] = []
    const result = migrateLegacyDataDir({
      dataDir: 'C:\\Users\\me\\AppData\\Roaming\\RyHarness\\ryharness-data',
      legacyDataDir: 'C:\\Users\\me\\AppData\\Roaming\\RyAgent\\ryagent-data',
      exists: (path) => {
        return path.includes('RyAgent')
      },
      move: (from, to) => {
        moved.push([from, to])
      },
      fileExists: (path) => {
        return path.endsWith('ryagent.db')
      },
      rename: (from, to) => {
        renamed.push([from, to])
      },
    })
    expect(result.migrated).toBe(true)
    expect(moved).toHaveLength(1)
    // 数据库不改名的话，迁过来的是一个空库——用户看到的就是"数据全没了"。
    expect(renamed).toHaveLength(1)
    expect(renamed[0]?.[0]).toContain('ryagent.db')
    expect(renamed[0]?.[1]).toContain('ryharness.db')
  })

  it('新目录已经存在时不动（用户自己建过新目录就说明他不要老数据）', () => {
    const result = migrateLegacyDataDir({
      dataDir: 'C:\\new',
      legacyDataDir: 'C:\\old',
      exists: () => {
        return true
      },
      move: () => {
        throw new Error('不该被调用')
      },
      fileExists: () => {
        return false
      },
      rename: () => {},
    })
    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('new-exists')
  })

  it('没有老目录时也什么都不做', () => {
    const result = migrateLegacyDataDir({
      dataDir: 'C:\\new',
      legacyDataDir: 'C:\\old',
      exists: () => {
        return false
      },
      move: () => {
        throw new Error('不该被调用')
      },
      fileExists: () => {
        return false
      },
      rename: () => {},
    })
    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('no-legacy')
  })
})
