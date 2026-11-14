import { describe, expect, test } from 'vitest'

import { formatPortInUseMessage } from '../../src/cli/hive.js'

describe('formatPortInUseMessage', () => {
  test('suggests a valid port when 65535 is in use', () => {
    const message = formatPortInUseMessage(65535)
    expect(message).not.toContain('65536')
    expect(message).toContain('hive --port 65534')
  })

  test('POSIX (mac/linux) suggests lsof + kill', () => {
    const message = formatPortInUseMessage(4010, 'darwin')
    expect(message).toContain('port 4010 is already in use')
    expect(message).toContain('lsof -tiTCP:4010 -sTCP:LISTEN | xargs kill')
    expect(message).not.toContain('netstat')
    expect(message).not.toContain('taskkill')
  })

  test('linux gets the same lsof / kill recipe as macOS', () => {
    const message = formatPortInUseMessage(4010, 'linux')
    expect(message).toContain('lsof -tiTCP:4010 -sTCP:LISTEN | xargs kill')
  })

  test('Windows suggests netstat + taskkill instead of lsof', () => {
    // The reported recovery hint must be runnable on the platform the user
    // is on. `lsof` and `xargs` don't exist on bare Windows; the Windows
    // equivalents are `netstat -ano | findstr` to locate the PID and
    // `taskkill /PID <pid> /F` to terminate it.
    const message = formatPortInUseMessage(4010, 'win32')
    expect(message).toContain('port 4010 is already in use')
    expect(message).toContain('netstat -ano | findstr ":4010"')
    expect(message).toContain('taskkill /PID <pid> /F')
    expect(message).not.toContain('lsof')
    expect(message).not.toContain('xargs')
  })

  test('the alternate-port hint is platform-independent', () => {
    const macMessage = formatPortInUseMessage(4010, 'darwin')
    const winMessage = formatPortInUseMessage(4010, 'win32')
    expect(macMessage).toContain('hive --port 4011')
    expect(winMessage).toContain('hive --port 4011')
  })

  test('opening the existing window is always suggested', () => {
    const macMessage = formatPortInUseMessage(4010, 'darwin')
    const winMessage = formatPortInUseMessage(4010, 'win32')
    expect(macMessage).toContain('http://127.0.0.1:4010')
    expect(winMessage).toContain('http://127.0.0.1:4010')
  })
})
