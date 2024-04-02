/**
 * Unit tests for the action's entrypoint, src/index.js
 */

const { run } = require('../src/main')

// Mock the action's entrypoint
jest.mock('../src/main', () => ({
  run: jest.fn()
}))

describe('index', () => {
  it('calls run when imported on linux', async () => {
    const { init } = require('../src/index')
    init('linux', 'x64')

    expect(run).toHaveBeenCalled()
  })

  it('fails when imported on platform other than linux', async () => {
    const { init } = require('../src/index')
    init('darwin', 'x64')

    expect(run).not.toHaveBeenCalled()
  })
})
