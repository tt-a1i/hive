process.stdin.setRawMode(true)
process.stdout.write('INPUT_PROBE_READY\r\n')
let stressTimer
let draft = ''
process.stdin.on('data', (bytes) => {
  if (bytes.toString() === '__STRESS_START__') {
    draft = ''
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[2;1H> ')
    let tick = 0
    stressTimer = setInterval(() => {
      process.stdout.write(`\x1b7\x1b[1;1H\x1b[2KSTRESS_TICK:${++tick}\x1b8`)
    }, 100)
    return
  }
  if (stressTimer) {
    if (bytes.toString() === '__STRESS_STOP__') {
      clearInterval(stressTimer)
      stressTimer = undefined
      process.stdout.write('\r\nSTRESS_DONE')
    } else if (/^a+$/.test(bytes.toString())) {
      draft += bytes.toString()
      process.stdout.write(`\x1b[2;1H\x1b[2K> ${draft}`)
    }
    return
  }
  for (let offset = 0; offset < bytes.length; offset += 16) {
    process.stdout.write(`INPUT_HEX:${bytes.subarray(offset, offset + 16).toString('hex')}\r\n`)
  }
  if (bytes.toString() === '__REPAINT__') {
    process.stdout.write('\x1b[?2026h\x1b[1;1Hhello')
    setTimeout(
      () => process.stdout.write('\x1b[1;1H\x1b[K\x1b[0 q\x1b[?25h\x1b[?2026l\x1b[?25l'),
      20
    )
    setTimeout(() => process.stdout.write('\x1b[8;1HREPAINT_DONE'), 60)
  }
})
