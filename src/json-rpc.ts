import jsonrpc = require('jsonrpc-lite')
import createDebug = require('debug')
import { Duplex } from 'stream'

const debug = createDebug('json-rpc-constructor')

interface JSONRPCOptions {
  objectMode?: boolean
}

interface MethodHandler<P, R> {
  (params: P): Promise<R>
}
interface NotificationHandler<P> {
  (params: P): Promise<void>
}

export interface JSONRPC extends Duplex {
  on(event: 'unhandledNotification', listener: (method: string, params: object) => void): this
  on(event: 'unexpectedResponse', listener: (payload: jsonrpc.IParsedObjectSuccess | jsonrpc.IParsedObjectError) => void): this
  on(event: 'error', listener: (method: string, params: object) => void): this
  on(event: string | symbol, listener: (...args: any[]) => void): this
}

export class JSONRPC extends Duplex {
  private readonly parent: JSONRPC | null
  private readonly objectMode: boolean

  private methods?: Map<string, MethodHandler<any, any>> = new Map()
  private notifications?: Map<string, NotificationHandler<any>> = new Map()
  private requests?: Map<number, { resolve: Function, reject: Function }>

  private incomingBuffer?: Buffer | Buffer[]
  private incomingLength?: number
  private batchMode?: boolean
  private outgoingPushed?: boolean

  private nextId: number = 0
  private pendingOutgoing: number = 0

  constructor(options: JSONRPCOptions = {}, parent?: JSONRPC) {
    super({ objectMode: options.objectMode })
    this.parent = parent || null
    this.objectMode = !!options.objectMode
  }

  public child(options: JSONRPCOptions = {}): Duplex {
    return new JSONRPC(options, this)
  }

  public method<P, R>(method: string, fn: MethodHandler<P, R>) {
    this.methods?.set(method, fn)
  }

  public notification<R>(method: string, fn: NotificationHandler<R>) {
    this.notifications?.set(method, fn)
  }

  private getHandler<
    T extends ('m' | 'n'),
    R extends (MethodHandler<any, any> | NotificationHandler<any> | null)
      = T extends 'm' ? (MethodHandler<any, any> | null) :
        T extends 'n' ? (NotificationHandler<any> | null) :
        never,
  >(
    type: T,
    method: string,
  ): R {
    const map =
      type === 'm' ? this.methods :
      type === 'n' ? this.notifications :
      <never> null

    const hit = map && map.get(method)
    if (hit) return hit as R
    if (this.parent) return this.parent.getHandler(type, method)
    return null as R
  }

  emit(type: string, ...args: any[]): boolean {
    const hasListeners = super.emit(type, ...args)
    if (!hasListeners && this.parent) return this.parent.emit(type, ...args)
    return hasListeners
  }

  public async call<R>(method: string, params: object): Promise<R> {
    debug('call', method, params)
    const id = ++this.nextId
    const data = jsonrpc.request(id, method, params)
    return new Promise((resolve, reject) => {
      if (!this.requests) this.requests = new Map()
      this.requests.set(id, { resolve, reject })
      this._send(data)
    })
  }

  public notify(method: string, params: object): void {
    const data = jsonrpc.notification(method, params)
    this._send(data)
  }

  _write(chunk: Buffer, _: unknown, cb: (err?: Error) => void) {
    debug('_write', chunk.length)
    if (this.objectMode) {
      this._handleIncoming(chunk)
    } else {
      if (!this.incomingBuffer) {
        this.incomingBuffer = chunk
      } else if (!Array.isArray(this.incomingBuffer)) {
        this.incomingLength = this.incomingBuffer.length + chunk.length
        this.incomingBuffer = [ this.incomingBuffer, chunk ]
      } else {
        this.incomingLength! += chunk.length
        this.incomingBuffer.push(chunk)
      }
    }
    cb()
  }

  _final(cb: (err?: Error) => void) {
    if (!this.objectMode && this.incomingBuffer) {
      const buffer =
        ( Array.isArray(this.incomingBuffer)
        ? Buffer.concat(this.incomingBuffer, this.incomingLength)
        : this.incomingBuffer
        )
      this.incomingBuffer = void 0
      this.incomingLength = void 0

      this._handleIncoming(buffer)
    }

    cb()
    this._maybeEnd()
  }

  private _handleIncoming(incoming: Buffer | string) {
    const parsed = jsonrpc.parse(incoming.toString())

    if (!this.objectMode) {
      this.batchMode = Array.isArray(parsed)
    }

    const messages =
      ( Array.isArray(parsed)
      ? parsed
      : [ parsed ]
      )

    for (const message of messages) {
      this._handleMessage(message)
    }
  }

  private _handleMessage(
    message: jsonrpc.IParsedObject,
  ): void {
    debug('handle incoming %s', message.type, message.payload)
    switch (message.type) {
      default: {
        throw new UnreachableCaseError(message)
      }

      case 'notification' as jsonrpc.RpcStatusType.notification: {
        const handler = this.getHandler('n', message.payload.method)
        if (!handler) {
          this.emit('unhandledNotification', message.payload.method, message.payload.params, this)
          return
        }

        this.pendingOutgoing++
        handler(message.payload.params)
        .catch((err) => {
          if (!this.emit('notificationError', err, this)) throw err
        })
        .then(() => {
          this.pendingOutgoing--
          this._maybeEnd()
        })
        .catch((err) => {
          process.nextTick(() => this.emit('error', err))
        })
      } break

      case 'request' as jsonrpc.RpcStatusType.request: {
        const handler = this.getHandler('m', message.payload.method)
        if (!handler) {
          this._send(jsonrpc.error(message.payload.id, jsonrpc.JsonRpcError.methodNotFound(null)))
          return
        }
        this.pendingOutgoing++
        handler(message.payload.params)
        .then((result) => {
          if (result instanceof jsonrpc.JsonRpcError) {
            return jsonrpc.error(message.payload.id, result)
          } else {
            return jsonrpc.success(message.payload.id, result || null)
          }
        })
        .catch((err: Error | jsonrpc.JsonRpcError) => {
          if (!(err instanceof jsonrpc.JsonRpcError)) {
            if (!this.emit('methodError', err, this)) throw err
            err = new jsonrpc.JsonRpcError('Unknown error', -32000)
          }
          return jsonrpc.error(message.payload.id, err)
        })
        .then((result) => {
          this._send(result)
          this.pendingOutgoing--
          this._maybeEnd()
        })
        .catch((err) => {
          process.nextTick(() => this.emit('error', err))
        })
      } break

      case 'success' as jsonrpc.RpcStatusType.success: {
        const id = message.payload.id as number
        const req = this.requests?.get(id)
        if (req) {
          this.requests!.delete(id)
          req.resolve(message.payload.result)
        } else {
          this.emit('unexpectedResponse', message.payload, this)
        }
      } break

      case 'error' as jsonrpc.RpcStatusType.error: {
        const id = message.payload.id as number
        const req = this.requests?.get(id)
        if (req) {
          this.requests!.delete(id)
          req.reject(message.payload.error)
        } else {
          this.emit('unexpectedResponse', message.payload, this)
        }
      } break

      case 'invalid' as jsonrpc.RpcStatusType.invalid: {
        this._send(jsonrpc.error(null as any, message.payload))
      } break
    }
  }

  _send(message: jsonrpc.JsonRpc) {
    debug('send', message)
    if (!this.objectMode && this.batchMode) {
      if (this.outgoingPushed) {
        this.push(',')
      } else {
        this.outgoingPushed = true
        this.push('[')
      }
    }
    this.push(message.serialize())
  }

  _read() {
    // noop
  }

  private _maybeEnd() {
    if (this.pendingOutgoing) return
    if (!this.writableFinished) return
    if (!this.objectMode && this.batchMode && this.outgoingPushed) {
      this.push(']')
    }
    this.push(null)
  }
}

class UnreachableCaseError extends Error {
  constructor(val: never) {
    super(`Unreachable case: ${val}`);
  }
}

export const JSONRPCError = jsonrpc.JsonRpcError
export default JSONRPC
