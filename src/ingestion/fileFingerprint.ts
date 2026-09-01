function readFile(file: Blob): Promise<ArrayBuffer> {
  if ('arrayBuffer' in file && typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(file)
  })
}

export async function fingerprintFile(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await readFile(file))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export { readFile }
