// xBooM pair API
// 1) returns a pairing code quickly as JSON
// 2) keeps working in the background (waitUntil) until the phone links,
//    then sends the SESSION_ID to the user's own WhatsApp chat.
import fs from 'fs'
import os from 'os'
import path from 'path'
import P from 'pino'
import { waitUntil } from '@vercel/functions'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion
} from '../xBooM-BAILEYS/lib/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TOTAL_TIMEOUT_MS = 240_000
const CODE_WAIT_MS = 25_000

async function runPairing(phone, ctl, onCode, onFail) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xboom-'))
  let sock = null
  let finished = false
  let codeSent = false
  let codeRequested = false
  let timer = null

  const cleanup = () => {
    try { sock?.ev?.removeAllListeners() } catch {}
    try { sock?.ws?.close() } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }

  await new Promise(async (resolve) => {
    const end = (errMsg) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (errMsg && !codeSent) onFail(new Error(errMsg))
      cleanup()
      resolve()
    }
    ctl.cancel = () => end()
    timer = setTimeout(() => end('Timed out.'), TOTAL_TIMEOUT_MS)

    try {
      const { state, saveCreds } = await useMultiFileAuthState(dir)
      // Use the real current WhatsApp Web version (a stale one blocks linking)
      let { version, isLatest } = await fetchLatestWaWebVersion()
      if (!isLatest) ({ version } = await fetchLatestBaileysVersion())

      const connect = () => {
        sock = makeWASocket({
          version,
          auth: state,
          logger: P({ level: 'silent' }),
          printQRInTerminal: false,
          browser: Browsers.ubuntu('Chrome') // custom names make WhatsApp reject pairing codes
        })
        sock.ev.on('creds.update', saveCreds)

        const requestCode = async () => {
          if (codeRequested || state.creds.registered || finished) return
          codeRequested = true
          try {
            const raw = await sock.requestPairingCode(phone)
            codeSent = true
            onCode(String(raw).replace(/(.{4})(?=.)/g, '$1-'))
          } catch (e) {
            end('Could not get a pairing code: ' + (e?.message || e))
          }
        }

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
          if (finished) return
          if (qr) requestCode()

          if (connection === 'open') {
            await sleep(2500) // let creds.json finish writing
            try {
              const raw = fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')
              const session = 'xBooM~' + Buffer.from(raw).toString('base64')
              const me = sock.user.id.split(':')[0].split('@')[0] + '@s.whatsapp.net'
              await sock.sendMessage(me, {
                text: '✅ *xBooM session created*\n\nYour SESSION_ID is in the next message. Copy it, add it as the SESSION_ID secret on GitHub, then delete both messages. Never share it.'
              })
              await sock.sendMessage(me, { text: session })
              await sleep(1500)
            } catch {}
            end()
          }

          if (connection === 'close') {
            const status = lastDisconnect?.error?.output?.statusCode
            if (status === DisconnectReason.restartRequired) {
              connect() // WhatsApp asks for a fresh socket right after pairing
            } else {
              end(`Connection closed (code ${status ?? 'unknown'}).`)
            }
          }
        })

        setTimeout(requestCode, 4000)
      }

      connect()
    } catch (e) {
      end('Server error: ' + (e?.message || e))
    }
  })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { number, key } = req.body || {}
  const phone = String(number || '').replace(/\D/g, '')

  if (process.env.PAIR_KEY && key !== process.env.PAIR_KEY) {
    return res.status(401).json({ error: 'Wrong access key.' })
  }
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: 'Enter your number with country code, digits only (e.g. 94771234567).' })
  }

  const ctl = { cancel: () => {} }
  let resolveCode, rejectCode
  const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject })

  // Keeps running after the response is sent, so it does not matter if the
  // browser tab goes to the background while the user types the code.
  waitUntil(runPairing(phone, ctl, resolveCode, rejectCode))

  try {
    const code = await Promise.race([
      codePromise,
      sleep(CODE_WAIT_MS).then(() => { throw new Error('No code received in time. Try again.') })
    ])
    return res.status(200).json({ code })
  } catch (e) {
    ctl.cancel()
    return res.status(500).json({ error: e?.message || 'Failed.' })
  }
}
