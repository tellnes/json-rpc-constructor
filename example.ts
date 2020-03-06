
import JSONRPC from './src/json-rpc'

const rpcA = new JSONRPC({ send(message) { rpcB.receive(message) }})
const rpcB = new JSONRPC({ send(message) { rpcA.receive(message) }})

interface Params {
  name: string
}

rpcA.method('hello', async (params: Params) => {
  return `Hello ${params.name}`
})

async function call() {
  const result: string = await rpcB.call('hello', { name: 'world' })
  console.log(result)
}
call()
