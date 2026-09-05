// Small text PDF with a coordinate table. No employee data or external files.
export function rosterPdf(code = '24', month = 'September') {
  const days = month === 'August' ? 31 : 30
  const commands = [`BT /F1 12 Tf 40 760 Td (${month} 2026) Tj ET`]
  const text = (x: number, y: number, value: string) =>
    commands.push(`BT /F1 8 Tf ${x} ${y} Td (${value}) Tj ET`)
  for (let day = 1; day <= days; day++) text(65 + (day - 1) * 16, 700, String(day))
  text(30, 670, 'D12')
  text(30, 640, 'D40')
  text(65 + 6 * 16, 670, code)
  text(65 + 7 * 16, 640, '8')
  text(65 + (days - 1) * 16, 670, '16')
  const stream = commands.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 620 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return { name: 'demo.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) }
}
