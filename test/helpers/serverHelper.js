import express from 'express'

export function createApp() {
  const app = express()
  app.use(express.json())
  return app
}

export function listenOnRandomPort(app) {
  return listenOnPort(app, 0)
}

export function listenOnPort(app, port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => {
      const { address, port: actualPort } = srv.address()
      resolve({
        port: actualPort,
        baseUrl: `http://${address}:${actualPort}`,
        close: () => new Promise((res) => srv.close(res)),
      })
    })
    srv.on('error', (err) => reject(err))
  })
}
