const lateAck = process.argv[2] === 'late'
let input = ''
let submitted = 0
let pasting = false
process.stdin.setRawMode(true)
const ack = () => process.stdout.write('\r\n[Pasted Content 2400 chars]\r\n')
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8')
  if (!pasting && input.includes('\x1b[201~')) {
    pasting = true
    if (!lateAck) ack()
  }
  if (!pasting) return
  const end = input.indexOf('\x1b[201~') + 6
  submitted = (input.slice(end).match(/\r/g) || []).length
  if (lateAck && submitted === 1) ack()
  if (submitted === (lateAck ? 2 : 1)) {
    const text = input.slice(6, end - 6)
    process.stdout.write(`\r\nSUBMITTED:${submitted}:${Buffer.from(text).toString('hex')}\r\n`)
  }
})
// An old acknowledgement must not authorize this next paste.
process.stdout.write('x'.repeat(1_100_000), () => {
  ack()
  process.stdout.write('\r\nLONG_OUTPUT_READY\r\n')
})
