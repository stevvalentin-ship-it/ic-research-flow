import { FileText, FolderOpen, UploadCloud } from 'lucide-react'
import { useRef, useState } from 'react'

export function FileDropzone({ files, onFiles }: { files: File[]; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const accept = (list: FileList | null) => {
    if (!list) return
    onFiles([...list].filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')))
  }
  return (
    <div
      className={`dropzone ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); accept(event.dataTransfer.files) }}
    >
      <input ref={input} hidden type="file" accept="application/pdf,.pdf" multiple onChange={(event) => accept(event.target.files)} />
      <div className="drop-icon"><UploadCloud size={25} /></div>
      <div>
        <h3>拖入集成电路论文 PDF</h3>
        <p>支持多选；文件只保存在当前浏览器，不会上传到本站服务器。</p>
      </div>
      <button type="button" className="secondary-button" onClick={() => input.current?.click()}>
        <FolderOpen size={16} />选择论文
      </button>
      {files.length > 0 && (
        <div className="selected-files">
          {files.slice(0, 4).map((file) => <span key={`${file.name}-${file.size}`}><FileText size={14} />{file.name}</span>)}
          {files.length > 4 && <span>另有 {files.length - 4} 篇</span>}
        </div>
      )}
    </div>
  )
}
