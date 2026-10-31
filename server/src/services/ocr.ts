import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * 扫描版 PDF OCR(部署侧能力):
 *
 * 依赖系统工具(3588 / macOS 均可用 apt/brew 安装):
 *   - poppler-utils(pdftoppm:PDF → 每页 PNG)
 *   - tesseract-ocr + tesseract-ocr-chi-sim(中文识别)
 *
 * 工具缺失时返回 missing-tools,由路由以 501 + 安装指引响应,不抛错。
 * 输出按「〔第 N 页〕」分隔,与文本型 PDF 的页码标记一致,便于问答引用页次。
 */
const execFileAsync = promisify(execFile)

export type OcrOutcome =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: 'missing-tools' | 'failed'; message: string }

const INSTALL_HINT =
  '服务器缺少 OCR 工具。请安装(部署机执行):apt install poppler-utils tesseract-ocr tesseract-ocr-chi-sim ' +
  '(或 macOS:brew install poppler tesseract tesseract-lang),安装后重启服务即可。'

export function hasTool(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export async function runOcr(pdfBuffer: Buffer, lang = 'chi_sim+eng'): Promise<OcrOutcome> {
  if (!hasTool('pdftoppm') || !hasTool('tesseract')) {
    return { ok: false, reason: 'missing-tools', message: INSTALL_HINT }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-ocr-'))
  try {
    const pdfPath = path.join(dir, 'input.pdf')
    fs.writeFileSync(pdfPath, pdfBuffer)

    await execFileAsync('pdftoppm', ['-png', '-r', '200', pdfPath, path.join(dir, 'page')], { timeout: 60_000 })
    const pages = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

    if (pages.length === 0) return { ok: false, reason: 'failed', message: '未能从 PDF 生成页面图像(文件可能已损坏或为空)' }

    const parts: string[] = []
    for (const png of pages) {
      const outBase = path.join(dir, 'txt-' + png)
      await execFileAsync('tesseract', [path.join(dir, png), outBase, '-l', lang], { timeout: 120_000 })
      const pageNo = Number((png.match(/^page-(d+)/) ?? [])[1] ?? 0)
      const text = fs.existsSync(outBase + '.txt') ? fs.readFileSync(outBase + '.txt', 'utf8').trim() : ''
      if (text) {
        parts.push('〔第 ' + pageNo + ' 页〕 ')
        parts.push(text)
        parts.push('\n')
      }
    }
    const text = parts.join('')
    if (!text) return { ok: false, reason: 'failed', message: 'OCR 未识别到文字(请确认使用清晰扫描件)' }
    return { ok: true, text, pages: pages.length }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
