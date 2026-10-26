import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { VibeProject } from './project.ts'
import type { VibeValidationReport } from './validation.ts'

export interface VibeProjectVersion {
  id: string
  project: VibeProject
  validation: VibeValidationReport
}

function safeFileName(name: string): string {
  if (name.length === 0 || basename(name) !== name || name === '.' || name === '..') {
    throw new Error('产物版本里有不安全的文件名')
  }
  return name
}

function inside(root: string, path: string): boolean {
  const base = resolve(root)
  const target = resolve(path)
  return target === base || target.startsWith(`${base}${sep}`)
}

export function snapshotProject(
  dataDir: string,
  sessionId: string,
  project: VibeProject,
  validation: VibeValidationReport,
): VibeProjectVersion {
  const id = randomUUID()
  const dir = join(dataDir, 'vibe', 'versions', sessionId, id)
  mkdirSync(dir, { recursive: true })
  const files = project.files.map((file) => {
    const name = safeFileName(file.name)
    if (!inside(project.dir, file.path)) throw new Error('产物文件不在项目目录里')
    const path = join(dir, name)
    copyFileSync(file.path, path)
    return { name, path, size: statSync(path).size }
  })
  return { id, project: { ...project, dir, files }, validation }
}

export function restoreProject(version: VibeProjectVersion, targetDir: string): VibeProject {
  mkdirSync(targetDir, { recursive: true })
  const keep = new Set(
    version.project.files.map((file) => {
      return safeFileName(file.name)
    }),
  )
  for (const entry of readdirSync(targetDir)) {
    if (keep.has(entry) || !/\.(?:md|csv|html)$/i.test(entry)) continue
    const path = join(targetDir, entry)
    if (statSync(path).isFile()) rmSync(path, { force: true })
  }
  const files = version.project.files.map((file) => {
    const name = safeFileName(file.name)
    if (!inside(version.project.dir, file.path)) throw new Error('版本快照不在受控目录里')
    const path = join(targetDir, name)
    copyFileSync(file.path, path)
    return { name, path, size: statSync(path).size }
  })
  return { ...version.project, dir: targetDir, files }
}

export function removeProjectVersion(dataDir: string, sessionId: string, versionId: string): void {
  const root = join(dataDir, 'vibe', 'versions', sessionId)
  const dir = join(root, versionId)
  if (inside(root, dir)) rmSync(dir, { recursive: true, force: true })
}
