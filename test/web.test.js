import test from 'node:test'
import assert from 'node:assert/strict'

import { registerSessionApi } from '../lib/web.js'

function captureRoute() {
  let route
  const ctx = {
    webServer: {
      register(value) {
        route = value
        return () => {}
      },
    },
  }
  return { ctx, route: () => route }
}

function jsonReq(url, body) {
  return {
    method: 'POST',
    url,
    setEncoding() {},
    on(event, callback) {
      if (event === 'data' && body) callback(JSON.stringify(body))
      if (event === 'end') callback()
    },
    destroy() {},
  }
}

function jsonRes() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body
    },
    $state: state,
  }
}

test('archive and unarchive HTTP routes call the service with sessionId', async () => {
  const calls = []
  const service = {
    archive: async (sessionId) => calls.push(['archive', sessionId]),
    unarchive: async (sessionId) => calls.push(['unarchive', sessionId]),
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)
  const api = '/@dsh-external/dsh-session-management/api'

  const archiveRes = jsonRes()
  await route().handler(jsonReq(`${api}/archive`, { sessionId: 's1' }), archiveRes)
  assert.deepEqual(calls, [['archive', 's1']])
  assert.equal(archiveRes.$state.status, 200)
  assert.deepEqual(JSON.parse(archiveRes.$state.body), { ok: true, sessionId: 's1' })

  const unarchiveRes = jsonRes()
  await route().handler(jsonReq(`${api}/unarchive`, { sessionId: 's1' }), unarchiveRes)
  assert.deepEqual(calls, [['archive', 's1'], ['unarchive', 's1']])
  assert.equal(unarchiveRes.$state.status, 200)
  assert.deepEqual(JSON.parse(unarchiveRes.$state.body), { ok: true, sessionId: 's1' })

  dispose()
})

test('archive route rejects a missing sessionId', async () => {
  const calls = []
  const service = {
    archive: async (sessionId) => calls.push(['archive', sessionId]),
    unarchive: async (sessionId) => calls.push(['unarchive', sessionId]),
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)
  const api = '/@dsh-external/dsh-session-management/api'

  const res = jsonRes()
  await route().handler(jsonReq(`${api}/archive`, {}), res)
  assert.equal(res.$state.status, 400)
  assert.deepEqual(JSON.parse(res.$state.body), { error: 'Missing sessionId' })
  assert.deepEqual(calls, [])
  dispose()
})