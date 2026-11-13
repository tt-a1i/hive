// @vitest-environment jsdom

import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { describe, expect, test } from 'vitest'

import {
  createSealer,
  deriveConnectionKeys,
  deriveDeviceSession,
  type HandshakeIds,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
  sealNext,
} from '../../src/shared/remote-crypto.js'
import {
  CONN_SALT_STREAM_ID,
  encodeConnSalt,
  encodeHeader,
  encodeWsMessage,
  FrameKind,
  HEADER_BYTES,
} from '../../src/shared/remote-protocol.js'
import { createFrameMux } from '../../web/src/transport/frame-mux.js'

const ids = (deviceId: string): HandshakeIds => ({
  daemonId: 'daemon-foreign',
  deviceId,
  protocolVersion: REMOTE_CRYPTO_VERSION,
})

const makeRoot = (id: HandshakeIds) => {
  const pairingSecret = randomBytes(PAIRING_SECRET_LEN)
  const sessionSalt = randomBytes(32)
  const daemonSk = x25519.utils.randomSecretKey()
  const deviceSk = x25519.utils.randomSecretKey()
  const phone = deriveDeviceSession({
    deviceSecretKey: deviceSk,
    daemonPublicKey: x25519.getPublicKey(daemonSk),
    devicePublicKey: x25519.getPublicKey(deviceSk),
    pairingSecret,
    sessionSalt,
    ids: id,
  })
  return { d2p: phone.d2p, p2d: phone.p2d }
}

const daemonConnSaltFrame = (salt: Uint8Array): Uint8Array => {
  const header = encodeHeader({
    version: REMOTE_CRYPTO_VERSION,
    kind: FrameKind.Data,
    flags: 0,
    streamId: CONN_SALT_STREAM_ID,
    seq: 0,
  })
  const body = encodeConnSalt({ role: 'daemon', salt })
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header, 0)
  frame.set(body, header.length)
  return frame
}

describe('frame-mux foreign-device frames', () => {
  test('a sealed frame for another device is dropped and the next own frame still opens', () => {
    const id = ids('device-B')
    const root = makeRoot(id)
    const phoneSalt = new Uint8Array(32).fill(0x11)
    const daemonSalt = new Uint8Array(32).fill(0x22)
    const mux = createFrameMux({
      roots: root,
      daemonId: id.daemonId,
      deviceId: id.deviceId,
      send: () => {},
      generateConnSalt: () => phoneSalt,
    })
    mux.beginChannel()
    mux.onFrame(daemonConnSaltFrame(daemonSalt))
    const received: unknown[] = []
    const socket = mux.openWebSocket('/ws/terminal')
    socket.onmessage = (event) => received.push(event.data)

    const foreignHeader = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: 1,
      seq: 0,
    })
    const foreignRoot = makeRoot(ids('device-A'))
    const foreignKeys = deriveConnectionKeys({
      rootD2p: foreignRoot.d2p,
      rootP2d: foreignRoot.p2d,
      phoneConnSalt: phoneSalt,
      daemonConnSalt: daemonSalt,
      ids: ids('device-A'),
    })
    const { ciphertext: foreignCiphertext } = sealNext(createSealer('d2p'), {
      key: foreignKeys.d2p,
      streamId: 1,
      headerBytes: foreignHeader,
      payload: encodeWsMessage(new TextEncoder().encode('foreign device payload'), true),
    })
    const foreign = new Uint8Array(HEADER_BYTES + foreignCiphertext.length)
    foreign.set(foreignHeader, 0)
    foreign.set(foreignCiphertext, HEADER_BYTES)
    mux.onFrame(foreign)
    expect(received).toEqual([])

    const connKeys = deriveConnectionKeys({
      rootD2p: root.d2p,
      rootP2d: root.p2d,
      phoneConnSalt: phoneSalt,
      daemonConnSalt: daemonSalt,
      ids: id,
    })
    const sealer = createSealer('d2p')
    const ownHeader = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: 1,
      seq: 0,
    })
    const { ciphertext } = sealNext(sealer, {
      key: connKeys.d2p,
      streamId: 1,
      headerBytes: ownHeader,
      payload: encodeWsMessage(new TextEncoder().encode('own device payload'), true),
    })
    const own = new Uint8Array(ownHeader.length + ciphertext.length)
    own.set(ownHeader, 0)
    own.set(ciphertext, ownHeader.length)
    mux.onFrame(own)
    expect(received).toEqual(['own device payload'])
  })
})
