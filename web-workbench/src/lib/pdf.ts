import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/**
 * 文件文本抽取:PDF 用 pdf.js 在浏览器端解析(支持中文文本型 PDF),
 * 其余按文本读取。抽取出的纯文本随上传请求交给服务端入库。
 *
 * 扫描版 PDF 抽取不到文本,服务端会以"内容为空"拒绝,提示先 OCR(后置能力)。
 */

let workerReady = false
function ensureWorker(): void {
  if (!workerReady) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    workerReady = true
  }
}

export async function extractTextFromFile(file: File): Promise<string> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.pdf')) return extractPdf(file)
  return file.text()
}

async function extractPdf(file: File): Promise<string> {
  ensureWorker()
  const data = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data }).promise
  const parts: string[] = []
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo)
      const content = await page.getTextContent()
      const line = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .trim()
      if (line) {
        // 页码标记:问答可据此引用"第 N 页",与 OCR 输出格式一致
        parts.push('〔第 ' + pageNo + ' 页〕 ')
        parts.push(line)
        parts.push('\n')
      }
      page.cleanup()
    }
  } finally {
    await doc.cleanup()
  }
  return parts.join('')
}
