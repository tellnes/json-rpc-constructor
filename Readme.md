# JSON-RPC Constructor

> A building block to create powerfull JSON-RPC apis

[![NPM Version][npm-image]][npm-url]
[![Downloads Stats][npm-downloads]][npm-url]

Most JSON-RPC implementations out there strongly separate the server and client
in the implementation and is directly coupled to an underlaying transport.
This library gives you the building blocks to create any JSON-RPC api over any
transport. It could be bidirectional over eg. websocket or a regular HTTP
server-client setup.

## Installation

```sh
yarn add json-rpc-constructor
```
or
```sh
npm install json-rpc-constructor --save
```

## Usage example

```ts
import JSONRPC from 'json-rpc-constructor'
import WebSocket = require('ws')

const ws = new WebSocket('ws://www.example.com/json-rpc')

const rpc = new JSONRPC({ send(data) {
  ws.send(data)
}})
ws.on('message', (data: string) => {
  rpc.receive(data)
})

rpc.method('subtract', async (params) => {
  return params[0] - params[1]
})

rpc.notification('foobar', (params) => {
  console.log('got incoming foobar notification', params)
})

ws.on('open', () => {
  rpc.call('get-server-time', (result) => {
    console.log('server time is', result)
  })
})
```


## Meta

Christian Vaagland Tellnes – [github.com/tellnes](https://github.com/tellnes)

Distributed under the MIT license. See ``LICENSE`` for more information.


## Contributing

1. Fork it (<https://github.com/tellnes/json-rpc-constructor/fork>)
2. Create your feature branch (`git checkout -b feature/fooBar`)
3. Commit your changes (`git commit -am 'Add some fooBar'`)
4. Push to the branch (`git push origin feature/fooBar`)
5. Create a new Pull Request


<!-- Markdown link & img dfn's -->
[npm-image]: https://img.shields.io/npm/v/json-rpc-constructor.svg?style=flat-square
[npm-url]: https://npmjs.org/package/json-rpc-constructor
[npm-downloads]: https://img.shields.io/npm/dm/json-rpc-constructor.svg?style=flat-square
