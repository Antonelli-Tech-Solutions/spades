import express from 'express'

export function createApp() {
  const app = express()
  app.use(express.json())
  return app
}

export function listenOnRandomPort(app) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const { port } = srv.address()
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => srv.close(res)),
      })
    })
    srv.on('error', reject)
  })
}
