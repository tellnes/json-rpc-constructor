import { EventEmitter } from 'events'
import jsonrpc = require('jsonrpc-lite')
import createDebug = require('debug')

const debug = createDebug('json-rpc-constructor')

interface JSONRPCOptions {
  send(message: string): void
}

interface MethodHandler<P, R> {
  (params: P): Promise<R>
}
interface NotificationHandler<P> {
  (params: P): void
}

export interface JSONRPC {
  on(event: 'unhandledNotification', listener: (method: string, params: object) => void): this
  on(event: 'unexpectedResponse', listener: (payload: jsonrpc.IParsedObjectSuccess | jsonrpc.IParsedObjectError) => void): this
  on(event: 'error', listener: (method: string, params: object) => void): this
}

export class JSONRPC extends EventEmitter {
  private readonly send: JSONRPCOptions['send']
  private readonly methods: Map<string, MethodHandler<any, any>> = new Map()
  private readonly notifications: Map<string, NotificationHandler<any>> = new Map()
  private readonly requests: Map<number, { resolve: Function, reject: Function }> = new Map()

  private nextId: number = 0

  constructor(options: JSONRPCOptions) {
    super()
    this.send = options.send
  }

  public method<P, R>(method: string, fn: MethodHandler<P, R>) {
    this.methods.set(method, fn)
  }

  public notification<R>(method: string, fn: NotificationHandler<R>) {
    this.notifications.set(method, fn)
  }

  public async call<R>(method: string, params: object): Promise<R> {
    const id = ++this.nextId
    const data = jsonrpc.request(id, method, params).serialize()
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject })
      this.send(data)
    })
  }

  public notify(method: string, params: object): void {
    const data = jsonrpc.notification(method, params).serialize()
    this.send(data)
  }

  public receive(data: string) {
    const parsed = jsonrpc.parse(data)
    if (Array.isArray(parsed)) {
      for (const message of parsed) {
        this.handleMessage(message)
      }
    } else {
      this.handleMessage(parsed)
    }
  }

  private handleMessage(message: jsonrpc.IParsedObject) {
    debug('handle incoming %s', message.type, message.payload)
    switch (message.type) {
      default: {
        throw new UnreachableCaseError(message)
      }

      case 'notification' as jsonrpc.RpcStatusType.notification: {
        const handler = this.notifications.get(message.payload.method)
        try {
          if (handler) {
            handler(message.payload.params)
          } else {
            this.emit('unhandledNotification', message.payload.method, message.payload.params)
          }
        } catch (err) {
          this.emit('error', err)
        }
      } break

      case 'request' as jsonrpc.RpcStatusType.request: {
        this.handleRequest(message.payload).then((result) => {
          return jsonrpc.success(message.payload.id, result || null)
        }, (err: jsonrpc.JsonRpcError) => {
          return jsonrpc.error(message.payload.id, err)
        }).then((res: jsonrpc.JsonRpc) => {
          debug('sending response', res)
          this.send(res.serialize())
        }).catch((err) => {
          this.emit('error', err)
        })
      } break

      case 'success' as jsonrpc.RpcStatusType.success: {
        const id = message.payload.id as number
        const req = this.requests.get(id)
        if (!req) {
          this.emit('unexpectedResponse', message.payload)
          return
        }
        this.requests.delete(id)
        req.resolve(message.payload.result)
      } break

      case 'error' as jsonrpc.RpcStatusType.error: {
        const id = message.payload.id as number
        const req = this.requests.get(id)
        if (!req) {
          this.emit('unexpectedResponse', message.payload)
          return
        }
        this.requests.delete(id)
        req.reject(message.payload.error)
      } break

      case 'invalid' as jsonrpc.RpcStatusType.invalid: {
        this.send(jsonrpc.error(null as any, message.payload).serialize())
      } break
    }
  }

  private async handleRequest(payload: jsonrpc.RequestObject) {
    const handler = this.methods.get(payload.method)
    if (!handler) {
      throw jsonrpc.JsonRpcError.methodNotFound(null)
    }

    try {
      return await handler(payload.params)

    } catch (err) {
      if (err instanceof jsonrpc.JsonRpcError) {
        throw err
      }

      throw new jsonrpc.JsonRpcError(err.message, -32000)
    }
  }
}

class UnreachableCaseError extends Error {
  constructor(val: never) {
    super(`Unreachable case: ${val}`);
  }
}

export default JSONRPC
